#!/usr/bin/env bun

import * as core from "@actions/core";
import * as fs from "fs/promises";
import { Gitlab } from "@gitbeaker/rest";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import type { GitLabNote } from "../types/gitbeaker";

/**
 * Parses the execution output file from the Claude Code SDK.
 * Note: This could be refactored into a shared utility with the GitHub version.
 */
async function getExecutionDetails(outputFile?: string): Promise<{
  cost_usd?: number;
  duration_ms?: number;
} | null> {
  if (!outputFile) return null;
  try {
    const fileContent = await fs.readFile(outputFile, "utf8");
    const outputData = JSON.parse(fileContent) as SDKMessage[];

    const result = outputData.find(
      (msg): msg is Extract<SDKMessage, { type: "result" }> =>
        msg.type === "result",
    );

    if (result && "cost_usd" in result && "duration_ms" in result) {
      return {
        cost_usd: result.cost_usd as number,
        duration_ms: result.duration_ms as number,
      };
    }
  } catch (error) {
    core.warning(`Error reading or parsing output file: ${error}`);
  }
  return null;
}

/**
 * Formats the final comment body for a GitLab merge request note.
 */
function formatGitLabCommentBody(
  initialBody: string,
  success: boolean,
  jobUrl: string,
  errorDetails?: string,
  executionDetails?: { cost_usd?: number; duration_ms?: number } | null,
): string {
  const statusMessage = success
    ? "✅ Claude's work is complete"
    : "❌ Claude's work failed";

  let finalBody = initialBody.replace(
    /🤖 Claude is working on this\.\.\./,
    statusMessage,
  );

  // Check off all items in the markdown task list
  finalBody = finalBody.replace(/- \[ \] /g, "- [x] ");

  // Ensure the job link is present
  if (!finalBody.includes(jobUrl)) {
    finalBody += `\n\n[View job details](${jobUrl})`;
  }

  if (errorDetails) {
    finalBody += `\n\n**Error:** \`${errorDetails}\``;
  }

  if (executionDetails) {
    const durationSec = (executionDetails.duration_ms ?? 0) / 1000;
    const cost = executionDetails.cost_usd?.toFixed(4) ?? "0.0000";
    finalBody += `\n\n---\n*Execution time: ${durationSec.toFixed(
      2,
    )}s | Estimated cost: $${cost}*`;
  }

  return finalBody;
}

async function run() {
  try {
    const commentId = parseInt(process.env.CLAUDE_COMMENT_ID!);
    if (isNaN(commentId)) {
      throw new Error("CLAUDE_COMMENT_ID env var is not a valid number.");
    }

    // Get GitLab context from environment
    const projectId = process.env.CI_PROJECT_ID;
    const mrIid = process.env.CI_MERGE_REQUEST_IID;
    const issueIid = process.env.CI_ISSUE_IID || process.env.CLAUDE_RESOURCE_ID;
    const gitlabHost = process.env.CI_SERVER_URL || "https://gitlab.com";
    const gitlabToken =
      process.env.CLAUDE_CODE_GL_ACCESS_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.GITLAB_TOKEN;

    if (!projectId || (!mrIid && !issueIid) || !gitlabToken) {
      throw new Error("Missing required GitLab environment variables");
    }

    // Initialize GitLab API
    const api = new Gitlab({
      host: gitlabHost,
      token: gitlabToken,
    });

    // Determine overall success/failure state
    const prepareSuccess = process.env.PREPARE_SUCCESS !== "false";
    const claudeSuccess = process.env.CLAUDE_SUCCESS !== "false";
    const actionSucceeded = prepareSuccess && claudeSuccess;
    const errorDetails = process.env.PREPARE_ERROR;

    // Get execution details from the Claude Code SDK output file
    const executionDetails = await getExecutionDetails(process.env.OUTPUT_FILE);

    // Fetch the original comment
    try {
      let notes: GitLabNote[];
      let resourceType: string;
      let resourceIid: number;

      console.log(`Looking for comment ${commentId} in project ${projectId}`);
      console.log(`MR IID: ${mrIid}, Issue IID: ${issueIid}`);
      console.log(`Resource type from CLAUDE_RESOURCE_TYPE: ${process.env.CLAUDE_RESOURCE_TYPE}`);

      if (mrIid) {
        // Merge request context
        console.log(`Fetching notes from MR ${mrIid}...`);
        notes = (await api.MergeRequestNotes.all(
          projectId,
          parseInt(mrIid),
        )) as unknown as GitLabNote[];
        resourceType = "merge request";
        resourceIid = parseInt(mrIid);
        console.log(`Found ${notes.length} notes in MR`);
      } else if (issueIid) {
        // Issue context
        console.log(`Fetching notes from issue ${issueIid}...`);
        notes = (await api.IssueNotes.all(
          projectId,
          parseInt(issueIid),
        )) as unknown as GitLabNote[];
        resourceType = "issue";
        resourceIid = parseInt(issueIid);
        console.log(`Found ${notes.length} notes in issue`);
      } else {
        throw new Error("No merge request or issue context found");
      }

      const originalComment = notes.find((note) => note.id === commentId);
      if (!originalComment) {
        console.warn(`Could not find comment ${commentId}. Available note IDs: ${notes.map(n => n.id).join(', ')}`);
        console.warn(`Skipping comment update - comment may have been deleted or is in a different resource`);
        return; // Exit gracefully instead of failing
      }

      // Get job URL
      const pipelineId = process.env.CI_PIPELINE_ID;
      const jobUrl = pipelineId
        ? `${gitlabHost}/${projectId}/-/pipelines/${pipelineId}`
        : `${gitlabHost}/${projectId}/-/pipelines`;

      const updatedBody = formatGitLabCommentBody(
        originalComment.body,
        actionSucceeded,
        jobUrl,
        errorDetails,
        executionDetails,
      );

      // Update the comment
      if (mrIid) {
        await api.MergeRequestNotes.edit(projectId, resourceIid, commentId, {
          body: updatedBody,
        });
      } else {
        await api.IssueNotes.edit(projectId, resourceIid, commentId, {
          body: updatedBody,
        });
      }

      console.log(`✅ Updated GitLab ${resourceType} note ${commentId}.`);
    } catch (error) {
      throw new Error(`Failed to fetch or update comment: ${error}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to update GitLab comment: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
