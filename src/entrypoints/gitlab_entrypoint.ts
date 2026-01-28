#!/usr/bin/env bun

/**
 * Unified GitLab entrypoint that combines prepare, execute, and update phases
 * This replaces the multi-step shell commands in GitLab CI with a single TypeScript file
 */

import { $ } from "bun";
import * as path from "path";
import {
  getClaudePromptsDirectory,
  getClaudeExecutionOutputPath,
} from "../utils/temp-directory";

interface PhaseResult {
  success: boolean;
  error?: string;
  commentId?: number;
  outputFile?: string;
}

async function runPreparePhase(): Promise<PhaseResult> {
  try {
    console.log("=========================================");
    console.log("Phase 1: Preparing Claude Code action...");
    console.log("=========================================");

    // Run prepare.ts and capture output
    const prepareResult =
      await $`bun run ${path.join(__dirname, "prepare.ts")}`.quiet();

    // Print the output for debugging
    console.log(prepareResult.stdout.toString());

    if (prepareResult.exitCode !== 0) {
      const errorOutput = prepareResult.stderr.toString();
      console.error("Prepare step failed:", errorOutput);
      return {
        success: false,
        error: errorOutput || "Prepare step failed",
      };
    }

    // Check if trigger was found by examining output
    const output = prepareResult.stdout.toString();
    if (output.includes("No trigger found")) {
      console.log("No trigger found, exiting...");
      return {
        success: false,
        error: "No trigger found",
      };
    }

    // Extract comment ID from file written by prepare.ts
    let commentId: number | undefined;
    try {
      const fs = await import("fs");
      if (fs.existsSync("/tmp/claude-comment-id.txt")) {
        const commentIdStr = fs
          .readFileSync("/tmp/claude-comment-id.txt", "utf-8")
          .trim();
        if (commentIdStr) {
          commentId = parseInt(commentIdStr);
          console.log(`Extracted comment ID from file: ${commentId}`);
        }
      }
    } catch (error) {
      console.error("Error reading comment ID file:", error);
    }

    return {
      success: true,
      commentId,
    };
  } catch (error) {
    console.error("Error in prepare phase:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runExecutePhase(
  prepareResult: PhaseResult,
): Promise<PhaseResult> {
  try {
    console.log("=========================================");
    console.log("Phase 2: Installing Claude Code...");
    console.log("=========================================");

    // Install Claude Code globally (use latest version)
    const installResult =
      await $`bun install -g @anthropic-ai/claude-code@latest`;
    console.log(installResult.stdout.toString());

    if (installResult.exitCode !== 0) {
      throw new Error(
        `Failed to install Claude Code: ${installResult.stderr.toString()}`,
      );
    }

    console.log("=========================================");
    console.log("Phase 3: Installing base-action dependencies...");
    console.log("=========================================");

    // Install base-action dependencies
    const baseActionPath = path.join(
      path.dirname(__dirname),
      "..",
      "base-action",
    );
    const depsResult = await $`cd ${baseActionPath} && bun install`;
    console.log(depsResult.stdout.toString());

    if (depsResult.exitCode !== 0) {
      throw new Error(
        `Failed to install base-action dependencies: ${depsResult.stderr.toString()}`,
      );
    }

    console.log("=========================================");
    console.log("Phase 4: Running Claude Code...");
    console.log("=========================================");

    // Check if prompt file exists and read its content
    const promptPath = `${getClaudePromptsDirectory()}/claude-prompt.txt`;
    let promptContent = "";
    try {
      const fs = await import("fs");
      promptContent = await fs.promises.readFile(promptPath, "utf-8");
      console.log(
        `Prompt file loaded, size: ${promptContent.length} characters`,
      );

      // Debug: Show first 500 chars of prompt
      if (promptContent.length > 0) {
        console.log("Prompt preview (first 500 chars):");
        console.log(promptContent.substring(0, 500));
        console.log("...");
      }
    } catch (error) {
      console.error("Failed to read prompt file:", error);
    }

    // Set up environment for base-action
    const env = {
      ...process.env,
      CLAUDE_CODE_ACTION: "1",
      INPUT_PROMPT_FILE: promptPath,
      INPUT_TIMEOUT_MINUTES: "30",
      INPUT_MCP_CONFIG: "",
      INPUT_SETTINGS: "",
      INPUT_SYSTEM_PROMPT: "",
      INPUT_APPEND_SYSTEM_PROMPT: "",
      INPUT_ALLOWED_TOOLS: process.env.ALLOWED_TOOLS || "",
      INPUT_DISALLOWED_TOOLS: process.env.DISALLOWED_TOOLS || "",
      INPUT_MAX_TURNS: process.env.MAX_TURNS || "",
      INPUT_CLAUDE_ENV: process.env.CLAUDE_ENV || "",
      INPUT_FALLBACK_MODEL: process.env.FALLBACK_MODEL || "",
      ANTHROPIC_MODEL: process.env.CLAUDE_MODEL || "sonnet",
      DETAILED_PERMISSION_MESSAGES: "1",
    };

    // Run the base-action
    const baseActionScript = path.join(baseActionPath, "src", "index.ts");
    const executeResult = await $`bun run ${baseActionScript}`.env(env).quiet();

    // Print output regardless of exit code
    console.log(executeResult.stdout.toString());
    if (executeResult.stderr.toString()) {
      console.error(executeResult.stderr.toString());
    }

    const outputFile = getClaudeExecutionOutputPath();

    return {
      success: executeResult.exitCode === 0,
      error:
        executeResult.exitCode !== 0 ? "Claude execution failed" : undefined,
      commentId: prepareResult.commentId,
      outputFile,
    };
  } catch (error) {
    console.error("Error in execute phase:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      commentId: prepareResult.commentId,
    };
  }
}

async function checkGitStatus(): Promise<boolean> {
  try {
    // Ensure we're in the project directory
    const projectDir = process.env.CI_PROJECT_DIR || process.env.PWD;
    if (projectDir) {
      process.chdir(projectDir);
    }
    
    // Clean up any temporary output files before checking git status
    // These files might be created by Claude Code during execution
    const tempFiles = ["output.txt", "*.log", "*.tmp"];
    for (const pattern of tempFiles) {
      try {
        await $`rm -f ${pattern}`.quiet();
      } catch {
        // Ignore errors if files don't exist
      }
    }

    const result = await $`git status --porcelain`.quiet();
    const statusOutput = result.stdout.toString().trim();
    console.log(`Git status check: ${statusOutput.length > 0 ? 'changes detected' : 'no changes'}`);
    if (statusOutput) {
      console.log(`Changed files:\n${statusOutput}`);
    }
    return statusOutput.length > 0;
  } catch (error) {
    console.error("Error checking git status:", error);
    return false;
  }
}

async function postCodeSuggestions(
  prepareResult: PhaseResult,
  _executeResult: PhaseResult,
): Promise<void> {
  try {
    console.log("=========================================");
    console.log("Posting Claude's code suggestions...");
    console.log("=========================================");

    // Ensure we're in the project directory
    const projectDir = process.env.CI_PROJECT_DIR || process.env.PWD;
    if (projectDir) {
      console.log(`Working in project directory: ${projectDir}`);
      process.chdir(projectDir);
    }

    // Get the diff of changes Claude made
    const diffResult = await $`git diff`.quiet();
    const diff = diffResult.stdout.toString();

    if (!diff.trim()) {
      console.log("No code changes to suggest");
      return;
    }

    console.log(`Captured ${diff.length} bytes of diff`);

    // Format the suggestions as a comment
    const provider = await import("../providers/provider-factory");
    const scmProvider = provider.createProvider({
      platform: "gitlab",
      token: provider.getToken(),
    });

    const suggestionComment = `## 🤖 Claude's Code Suggestions

I've analyzed the code and have the following suggestions:

### Proposed Changes

\`\`\`diff
${diff}
\`\`\`

### Summary

${diff.split('\n').filter(line => line.startsWith('diff --git')).length} file(s) would be modified with these suggestions.

---
*These are suggested changes. Review and apply them manually if they look good, or ask me to explain the reasoning.*`;

    await scmProvider.createComment(suggestionComment);
    console.log("✅ Posted code suggestions to GitLab");
  } catch (error) {
    console.error("Error posting code suggestions:", error);
    throw error;
  }
}
      }
    }
  } catch (error) {
    console.error("Error creating merge request:", error);
    throw error;
  }
}

async function postClaudeResponse(
  _prepareResult: PhaseResult,
  executeResult: PhaseResult,
): Promise<void> {
  try {
    console.log("=========================================");
    console.log("Posting Claude's response to GitLab...");
    console.log("=========================================");

    // Read the output file
    const fs = await import("fs");
    const outputPath =
      executeResult.outputFile || getClaudeExecutionOutputPath();

    try {
      const outputContent = await fs.promises.readFile(outputPath, "utf-8");

      // Parse the JSONL output (multiple JSON objects separated by newlines)
      const lines = outputContent.trim().split("\n");
      let claudeMessage = "";

      // Process each line as a separate JSON object
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const output = JSON.parse(line);

          // Look for the result in the final result object
          if (output.type === "result" && output.result) {
            claudeMessage = output.result;
            break;
          }

          // Also check assistant messages
          if (output.type === "assistant" && output.message?.content) {
            let tempMessage = "";
            for (const content of output.message.content) {
              if (content.type === "text") {
                tempMessage += content.text + "\n";
              }
            }
            if (tempMessage) {
              claudeMessage = tempMessage.trim();
            }
          }
        } catch (parseError) {
          console.error("Error parsing line:", parseError);
          continue;
        }
      }

      if (!claudeMessage) {
        console.log("No message found in Claude's output");
        console.log("Output content:", outputContent.substring(0, 500));
        return;
      }

      // Post the response as a comment
      const provider = await import("../providers/provider-factory");
      const scmProvider = provider.createProvider({
        platform: "gitlab",
        token: provider.getToken(),
      });

      const formattedMessage = `## 🤖 Claude's Response

${claudeMessage}

---
*This response was generated by Claude AI. No code changes were made.*`;

      await scmProvider.createComment(formattedMessage);
      console.log("✅ Posted Claude's response to GitLab");
    } catch (fileError) {
      console.error("Error reading output file:", fileError);
      console.error("Output path:", outputPath);
      return;
    }
  } catch (error) {
    console.error("Error posting Claude's response:", error);
  }
}

async function runUpdatePhase(
  prepareResult: PhaseResult,
  executeResult: PhaseResult,
): Promise<PhaseResult> {
  try {
    // Check if there are any git changes
    const hasChanges = await checkGitStatus();

    if (hasChanges) {
      console.log("Git changes detected - posting code suggestions as comment");
      await postCodeSuggestions(prepareResult, executeResult);
    } else {
      console.log("No git changes detected - posting Claude's response");
      await postClaudeResponse(prepareResult, executeResult);
    }

    // Also update the tracking comment if we have one
    if (!prepareResult.commentId) {
      console.log("No comment ID available, skipping comment update");
      return { success: true };
    }

    console.log("=========================================");
    console.log("Phase 5: Updating tracking comment...");
    console.log("=========================================");

    // Set up environment for update script
    const env = {
      ...process.env,
      CLAUDE_COMMENT_ID: prepareResult.commentId.toString(),
      CLAUDE_SUCCESS: executeResult.success ? "true" : "false",
      PREPARE_SUCCESS: prepareResult.success ? "true" : "false",
      OUTPUT_FILE: executeResult.outputFile || getClaudeExecutionOutputPath(),
    };

    // Set correct IID based on resource type
    if (process.env.CLAUDE_RESOURCE_TYPE === "merge_request" && process.env.CLAUDE_RESOURCE_ID) {
      (env as any).CI_MERGE_REQUEST_IID = process.env.CLAUDE_RESOURCE_ID;
    } else if (process.env.CLAUDE_RESOURCE_TYPE === "issue" && process.env.CLAUDE_RESOURCE_ID) {
      (env as any).CI_ISSUE_IID = process.env.CLAUDE_RESOURCE_ID;
    }

    // Run update script
    const updateScript = path.join(__dirname, "update-comment-gitlab.ts");
    const updateResult = await $`bun run ${updateScript}`.env(env).quiet();

    console.log(updateResult.stdout.toString());

    if (updateResult.exitCode !== 0) {
      console.error(
        "Failed to update comment:",
        updateResult.stderr.toString(),
      );
      return {
        success: false,
        error: "Failed to update comment",
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error in update phase:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  let exitCode = 0;
  let prepareResult: PhaseResult = { success: false };
  let executeResult: PhaseResult = { success: false };

  try {
    // Phase 1: Prepare
    prepareResult = await runPreparePhase();

    if (!prepareResult.success) {
      // Exit early if prepare failed (no trigger found is not an error)
      if (prepareResult.error === "No trigger found") {
        console.log("✅ No Claude trigger found in the request");
        process.exit(0);
      }
      throw new Error(`Prepare phase failed: ${prepareResult.error}`);
    }

    // Phase 2: Execute
    executeResult = await runExecutePhase(prepareResult);

    if (!executeResult.success) {
      exitCode = 1;
      console.error(`Execute phase failed: ${executeResult.error}`);
    }

    // Phase 3: Update (always run after execution completes)
    // This should run whether execute succeeded or failed
    const updateResult = await runUpdatePhase(prepareResult, executeResult);
    if (!updateResult.success) {
      console.error("Warning: Failed to update comment");
      // Don't fail the entire job just because update failed
    }
  } catch (error) {
    exitCode = 1;
    console.error("Fatal error:", error);

    // Even on fatal error, try to update if we have a comment
    if (prepareResult.commentId) {
      try {
        const updateResult = await runUpdatePhase(prepareResult, executeResult);
        if (!updateResult.success) {
          console.error("Warning: Failed to update comment after fatal error");
        }
      } catch (updateError) {
        console.error("Error during emergency update:", updateError);
      }
    }
  }

  // Exit with appropriate code
  process.exit(exitCode);
}

// Run the main function
if (import.meta.main) {
  main();
}
