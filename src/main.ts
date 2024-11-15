import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import nodeFetch from 'node-fetch';
import * as yaml from 'js-yaml';

interface ExecResult {
  err?: Error | undefined;
  stdout: string;
  stderr: string;
}

interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: Object;
      helm: Object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const ENV = core.getInput('environment');
const PLAINTEXT = core.getInput('plaintext').toLowerCase() === "true";
const COLLAPSE_DIFF = core.getInput('collapse-diff').toLowerCase() === "true";
const TIMEZONE = core.getInput('timezone');
const TIMEZONE_LOCALE = core.getInput('timezone-locale');
const DIFF_TOOL = core.getInput('diff-tool') || 'diff -N -u';
const TRACKING_LABEL = core.getInput('tracking-label') || 'argocd.argoproj.io/instance';
let EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');
if (PLAINTEXT) {
  EXTRA_CLI_ARGS += ' --plaintext';
}

const octokit = github.getOctokit(githubToken);

async function execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const p = new Promise<ExecResult>(async (done, failed) => {
    exec(command, options, (err: ExecException | null, stdout: string, stderr: string): void => {
      const res: ExecResult = {
        stdout,
        stderr
      };
      if (err) {
        res.err = err;
        failed(res);
        return;
      }
      done(res);
    });
  });
  return await p;
}

function scrubSecrets(input: string): string {
  let output = input;
  const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
  if (authTokenMatches) {
    output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
  }
  return output;
}

async function setupArgoCDCommand(): Promise<(params: string) => Promise<ExecResult>> {
  const argoBinaryPath = 'bin/argo';
  await tc.downloadTool(
    `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`,
    argoBinaryPath
  );
  fs.chmodSync(path.join(argoBinaryPath), '755');

  // core.addPath(argoBinaryPath);

  return async (params: string) =>
    execCommand(
      `KUBECTL_EXTERNAL_DIFF='${DIFF_TOOL}' ${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`
    );
}

async function getApps(): Promise<App[]> {
  let protocol = 'https';
  if (PLAINTEXT) {
    protocol = 'http';
  }
  const url = `${protocol}://${ARGOCD_SERVER_URL}/api/v1/applications`;
  core.info(`Fetching apps from: ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseJson: any;
  try {
    const response = await nodeFetch(url, {
      method: 'GET',
      headers: { Cookie: `argocd.token=${ARGOCD_TOKEN}` }
    });
    responseJson = await response.json();
  } catch (e) {
    core.error(e as Error);
  }
  const apps = responseJson.items as App[];
  const repoApps = apps.filter(app => {
    const targetRevision = app.spec.source.targetRevision;
    const targetPrimary = targetRevision === 'master' || targetRevision === 'main' || targetRevision === 'HEAD' || !targetRevision;
    return (
      app.spec.source.repoURL.includes(
        `${github.context.repo.owner}/${github.context.repo.repo}`
      ) && targetPrimary
    );
  });

  return repoApps;
}

interface Diff {
  app: App;
  diff: string;
  error?: ExecResult;
}
async function postDiffComment(diffs: Diff[]): Promise<void> {
  const maxCommentLength = 65536; // GitHub comment character limit
  const commentHeader = "### ArgoCD Diff Results\n";
  const commentFooter = "\n---\n";

  for (const diff of diffs) {
    let commentBody = `${commentHeader}\nApp: ${diff.app.metadata.name}\n\n\`\`\`diff\n${diff.diff}\n\`\`\`${commentFooter}`;
    if (diff.error) {
      commentBody += `\n**Error:**\n\`\`\`\n${diff.error.stderr}\n\`\`\``;
    }

    // Split the comment body if it exceeds the maximum length
    if (commentBody.length > maxCommentLength) {
      const chunks = splitIntoChunks(commentBody, maxCommentLength);
      for (const chunk of chunks) {
        await postComment(chunk);
      }
    } else {
      await postComment(commentBody);
    }
  }
}

function splitIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end > text.length) {
      end = text.length;
    } else {
      // Ensure we don't split in the middle of a line
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start) {
        end = lastNewline;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function postComment(body: string): Promise<void> {
  const octokit = github.getOctokit(core.getInput('github-token'));
  const context = github.context;

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: context.issue.number,
    body
  });
}

async function getChangedFiles(): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const pull_number = github.context.issue.number;

  const listFilesResponse = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number
  });

  const changedFiles = listFilesResponse.data.map(file => file.filename);
  return changedFiles;
}

function partOfApp(changedFiles: string[], app: App): boolean {
  const appName = app.metadata.name;
  
  console.log(`Checking if changed files are part of the app: ${appName}`);

  return changedFiles.some(file => {
    console.log(`Processing file: ${file}`);
    try {
      const fileContent = fs.readFileSync(file, 'utf8');
      console.log(`File content read successfully: ${file}`);

      const fileData = yaml.load(fileContent) as { metadata?: { labels?: { [key: string]: string } }, labels?: { pairs?: { [key: string]: string } }[] };
      console.log(`File parsed as YAML: ${file}`);

      if (fileData) {
        // Check metadata labels
        if (fileData.metadata && fileData.metadata.labels) {
          const labels = fileData.metadata.labels;
          console.log(`Metadata labels found in file: ${JSON.stringify(labels)}`);
          const isPartOfApp = labels[TRACKING_LABEL] === appName;
          console.log(`Is file part of app (${appName}) based on metadata labels: ${isPartOfApp}`);
          if (isPartOfApp) return true;
        }

        // Check labels array with pairsfor kustomize
        if (fileData.labels) {
          const isPartOfApp = fileData.labels.some(label => {
            const pairs = label.pairs;
            console.log(`Label pairs found in file: ${JSON.stringify(pairs)}`);
            return pairs && pairs[TRACKING_LABEL] === appName;
          });
          console.log(`Is file part of app (${appName}) based on label pairs: ${isPartOfApp}`);
          if (isPartOfApp) return true;
        }
      } else {
        console.log(`No labels found in file: ${file}`);
      }
    } catch (error) {
      console.error(`Error reading or parsing file ${file}:`, error);
    }
    return false;
  });
}

async function asyncForEach<T>(
  array: T[],
  callback: (item: T, i: number, arr: T[]) => Promise<void>
): Promise<void> {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

async function run(): Promise<void> {
  const argocd = await setupArgoCDCommand();
  const apps = await getApps();

  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  const diffs: Diff[] = [];

  await asyncForEach(apps, async app => {
    const changedFiles = await getChangedFiles();
    console.log(`Changed files: ${changedFiles.join(', ')}`);
    const appAffected = partOfApp(changedFiles, app);
    if (appAffected === false) {
      console.log(`App ${app.metadata.name} not affected by changes`);
      return;
    } else {
      const command = `app diff ${app.metadata.name} --local-repo-root=${process.cwd()} --local=${app.spec.source.path}`;
      try {
        core.info(`Running: argocd ${command}`);
        // ArgoCD app diff will exit 1 if there is a diff, so always catch,
        // and then consider it a success if there's a diff in stdout
        // https://github.com/argoproj/argo-cd/issues/3588
        await argocd(command);
      } catch (e) {
        const res = e as ExecResult;
        core.info(`stdout: ${res.stdout}`);
        core.info(`stderr: ${res.stderr}`);
        if (res.stdout) {
          diffs.push({ app, diff: res.stdout });
        } else {
          diffs.push({
            app,
            diff: '',
            error: res // Cast e to ExecResult
          });
        }
      }
      await postDiffComment(diffs);
      const diffsWithErrors = diffs.filter(d => d.error);
      if (diffsWithErrors.length) {
        core.setFailed(`ArgoCD diff failed: Encountered ${diffsWithErrors.length} errors`);
      }
    }
  });
}

function filterDiff(diffText: string) {
  // Split the diff text into sections based on the headers
  const sections = diffText.split(/(?=^===== )/m);

  const filteredSection = sections.map(section => {
    var removedLabels = section.replace(/(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+argocd\.argoproj\.io\/instance:.*\n---\n>\s+argocd\.argoproj\.io\/instance:.*\n?/g, '').trim();
    removedLabels = removedLabels.replace(/(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+app.kubernetes.io\/part-of:.*\n?/g, '').trim();
    return removedLabels;
  }).filter(section => section.trim() !== '');

  const removeEmptyHeaders = filteredSection.filter(entry => {
    // Remove empty strings and sections that are just headers with line numbers
    return !entry.match(/^===== .*\/.* ======$/);
  });

  // Join the filtered sections back together
  return removeEmptyHeaders.join('\n').trim();
}

run().catch(e => core.setFailed(e.message));
