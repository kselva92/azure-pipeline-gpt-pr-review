import fetch from "node-fetch";
import { git } from "./git";
import { CreateChatCompletionResponseChoicesInner, OpenAIApi } from "openai";
import { addCommentToPR } from "./pr";
import { Agent } from "https";
import * as tl from "azure-pipelines-task-lib/task";
import { log } from "console";

const MAX_TOKENS = 2048; // This is an example. Adjust based on your OpenAI plan.

function countTokens(str: string): number {
  return str.split(/\s+/).length;
}

function truncateContent(content: string, maxTokens: number): string {
  const tokens = content.split(/\s+/);
  return tokens.slice(0, maxTokens).join(" ");
}

async function isFileWithIgnoredGitStatus(fileName: string) {
  const fileStatus = await git.status([fileName]);

  return fileStatus.deleted.length > 0;
}

const IGNORED_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".svg",
  ".ico",
  ".csv",
  ".json",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".webm",
  ".ogg",
  ".wav",
];

function isBinary(content: string): boolean {
  // Check for non-textual characters in the first few bytes of the content
  for (let i = 0; i < Math.min(24, content.length); i++) {
    const charCode = content.charCodeAt(i);
    if (charCode === 0 || charCode > 127) {
      return true;
    }
  }
  return false;
}

function isFileWithIgnoredFileExtension(
  fileName: string,
  content: string
): boolean {
  const fileExtension = fileName.slice(
    ((fileName.lastIndexOf(".") - 1) >>> 0) + 2
  );

  if (IGNORED_EXTENSIONS.includes(`.${fileExtension}`) || isBinary(content)) {
    return true;
  }
  return false;
}

export async function reviewFile(
  targetBranch: string,
  fileName: string,
  httpsAgent: Agent,
  apiKey: string,
  openai: OpenAIApi | undefined,
  aoiEndpoint: string | undefined
) {
  console.log(`Start reviewing ${fileName} ...`);

  // const fileStatus = await git.status([fileName]);
  const isIgnoredGitStatus = await isFileWithIgnoredGitStatus(fileName);
  if (isIgnoredGitStatus) {
    console.log(`${fileName} is deleted. Skipping review.`);
    return;
  }

  let fileContent = await git.show([`${targetBranch}:${fileName}`]);

  const isIgnoredFileExtension = isFileWithIgnoredFileExtension(
    fileName,
    fileContent
  );

  if (isIgnoredFileExtension) {
    console.log(`${fileName} is ignored. Skipping review.`);
    return;
  }

  const defaultOpenAIModel = "gpt-3.5-turbo";
  const patch = await git.diff([targetBranch, "--", fileName]);

  const noFeedback = "NF";

  let instructions = `
  Review PR changes in unidiff format and surrounding code context. If you find no significant issues across ALL categories, your ENTIRE response should be 'NF'. NOTHING ELSE. 
  If there are issues in ANY category:
    1. Code Consistency
    2. Performance
    3. Security
    4. Readability
    5. Error Handling
    6. Compatibility
    7. Best Practices
  ONLY then provide feedback. 
  DO NOT, under any circumstances, mention categories that have no issues. Wasting the reviewer's time is unacceptable.
  For categories with issues:
    - Be concise.
    - Rate issues (1-5, 5 highest). Optionally, add an emoji: 'Severity: 3 :emoji:'.
  Rules:
    1. It's generally better to use 'if (!!object)' over 'if (object)'.
    2. Try to use 'const' for variables that won't be reassigned.
    3. To improve readability, consider using early returns instead of nested 'if' statements.
    4. Descriptive names are clearer than abbreviations.
    5. Instead of magic numbers, named constants can be more informative.
    6. Aim for functions/methods that are short and focused on a single task.
    7. While comments can be helpful, it's always best if the code can explain itself.
  Stick to the main instructions. No deviations.
  `;

  const customPrompt = tl.getInput("custom_prompt");
  if (!!customPrompt) {
    if (tl.getBoolInput("override_prompt")) {
      instructions = customPrompt;
    } else {
      instructions = `${customPrompt}\n${instructions}`;
    }
  }

  log(`Instructions: ${instructions}`);

  const model = tl.getInput("model") || defaultOpenAIModel;

  const totalTokens = countTokens(instructions + patch + fileContent);

  // This is just the first version, not sure about the best way to handle this.
  if (totalTokens > MAX_TOKENS) {
    console.warn(
      `Content exceeds token limit by ${
        totalTokens - MAX_TOKENS
      } tokens. Truncating...`
    );
    fileContent = truncateContent(
      fileContent,
      MAX_TOKENS - patch.length - instructions.length - 100
    ); // Reserve some tokens for potential API overhead.
  }

  try {
    let choices: CreateChatCompletionResponseChoicesInner[] = [];

    if (openai) {
      const response = await openai.createChatCompletion({
        model: model,
        messages: [
          {
            role: "system",
            content: instructions,
          },
          {
            role: "user",
            content: patch,
          },
          {
            role: "user",
            content: `Surrounding code : ${fileContent}`,
          },
        ],
        max_tokens: 500,
      });

      choices = response.data.choices;
    } else if (aoiEndpoint) {
      const request = await fetch(aoiEndpoint, {
        method: "POST",
        headers: { "api-key": `${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 500,
          messages: [
            {
              role: "user",
              content: `${instructions}\n, patch : ${patch}}`,
            },
          ],
        }),
      });

      const response = await request.json();

      choices = response.choices;
    }

    if (choices && choices.length > 0) {
      const review = choices[0].message?.content as string;
      console.log(review);

      if (!review.trim().startsWith(noFeedback)) {
        await addCommentToPR(fileName, review, httpsAgent);
      }
    }

    console.log(`Review of ${fileName} completed.`);
  } catch (error: any) {
    if (error.response) {
      console.log(error.response.status);
      console.log(error.response.data);
    } else {
      console.log(error.message);
    }
  }
}
