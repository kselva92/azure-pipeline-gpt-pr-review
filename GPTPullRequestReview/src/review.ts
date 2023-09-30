import fetch from "node-fetch";
import { git } from "./git";
import { OpenAIApi } from "openai";
import { addCommentToPR } from "./pr";
import { Agent } from "https";
import * as tl from "azure-pipelines-task-lib/task";

export async function reviewFile(
  targetBranch: string,
  fileName: string,
  httpsAgent: Agent,
  apiKey: string,
  openai: OpenAIApi | undefined,
  aoiEndpoint: string | undefined
) {
  console.log(`Start reviewing ${fileName} ...`);

  const defaultOpenAIModel = "gpt-3.5-turbo";
  const patch = await git.diff([targetBranch, "--", fileName]);

  const noFeedback = "#NF";

  const instructions = `
Review the provided Pull Request changes in patch format. Each patch entry has the commit message in the Subject line followed by the code changes (diffs) in a unidiff format.
Tasks:
- Review only added, edited, or deleted lines. Ignore formatting changes.
- As the first sentence, rate the severity of each issue (1-5, with 5 being the most severe) and optionally add an emoji. Format: 'Severity: 3 :emoji:'
- Focus on issues. If all is good, simply write '${noFeedback}' Otherwise, provide concise feedback and end with a compliment if deserved.
Another rules:
- Always prefer 'if (!!object)' over 'if (object)'.
`;

  try {
    let choices: any;

    if (openai) {
      const response = await openai.createChatCompletion({
        model: tl.getInput("model") || defaultOpenAIModel,
        messages: [
          {
            role: "system",
            content: instructions,
          },
          {
            role: "user",
            content: patch,
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

      if (review.trim() !== noFeedback) {
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
