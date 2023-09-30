import fetch from "node-fetch";
import { git } from "./git";
import { CreateChatCompletionResponseChoicesInner, OpenAIApi } from "openai";
import { addCommentToPR } from "./pr";
import { Agent } from "https";
import * as tl from "azure-pipelines-task-lib/task";
import { encoding_for_model, TiktokenModel } from "@dqbd/tiktoken";

const MAX_TOKENS = 2048; // This is an example. Adjust based on your OpenAI plan.

function countTokens(model: string, str: string): number {
  try {
    const encoder = encoding_for_model(model as TiktokenModel);

    const tokens = encoder.encode(str);
    encoder.free();
    return tokens.length;
  } catch (error: any) {
    return 0;
  }
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
Review PR changes provided in unidiff format. Focus on the content, not formatting.
Tasks:
- If no issues, respond with '${noFeedback}'.
- Rate issues (1-5, 5 highest). Optionally, add an emoji: 'Severity: 3 :emoji:'.
- Provide concise feedback. Offer fixes if possible.
- Check for:
  1. Code Consistency: Align with established conventions and patterns.
  2. Performance: Identify inefficiencies or bottlenecks.
  3. Security: Spot vulnerabilities or risky practices.
  4. Readability: Ensure code is clear with meaningful names and comments.
  5. Error Handling: Check for graceful error or exception handling.
  6. Compatibility: Ensure changes maintain backward compatibility or are flagged if not.
  7. Best Practices: Adhere to industry and language-specific standards.
- Be precise; senior devs will review your feedback.
- Keep comments brief. Developers will investigate further if needed.
Rules:
1. Prioritize 'if (!!object)' over 'if (object)'.
2. Use 'const' for variables that won't be reassigned.
3. Use early returns to avoid nested 'if' statements.
4. Use descriptive names. Avoid abbreviations.
5. Avoid magic numbers; use named constants.
6. Keep functions/methods short and focused on a single task.
7. Use comments sparingly. Prefer self-explanatory code.
`;

  const customPrompt = tl.getInput("custom_prompt");
  if (!!customPrompt) {
    if (tl.getBoolInput("override_prompt")) {
      instructions = customPrompt;
    } else {
      instructions = `${customPrompt}\n${instructions}`;
    }
  }
  const model = tl.getInput("model") || defaultOpenAIModel;

  const totalTokens = countTokens(model, instructions + patch + fileContent);

  // This is just the first version, not sure about the best way to handle this.
  if (totalTokens > MAX_TOKENS) {
    console.warn(
      `Content exceeds token limit by ${
        totalTokens - MAX_TOKENS
      } tokens. Truncating...`
    );
    fileContent = truncateContent(fileContent, MAX_TOKENS - 100); // Reserve some tokens for potential API overhead.
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
