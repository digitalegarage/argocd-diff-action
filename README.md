# ArgoCD Diff GitHub Action

This action generates a diff between the current PR and the current state of the cluster.

Note that this includes any changes between your branch and latest `master`, as well as ways in which the cluster is out of sync. 

Its a fork from https://github.com/quizlet/argocd-diff-action which didn't meet our requirements, so we adapted it to meet our requirements.

## Usage

Create the ARGOCD_TOKEN like:

Ensure a user is present in ArgoCD, via ArgoCD Operator this looks like this:

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd
spec:
...
  applicationInstanceLabelKey: argocd.argoproj.io/instance
  rbac:
    policy: |
...
      g, github-actions, role:readonly
...
```

Login into Argocd

```bash
argocd login argocd.pub-staging.tech --username admin
```

Generate the token and save it to Github Secrets in the repository where the action should run:

```bash
argocd account generate-token --account github-actions
```

Example GH action:
```yaml
name: ArgoCD Diff

on:
  pull_request:
    branches: [master, main]

jobs:
  argocd-diff:
    name: Generate ArgoCD Diff
    runs-on: ubuntu-latest
    steps:

      - name: Checkout repo
        uses: actions/checkout@v2

      - uses: digitalegarage/argocd-diff-action@master
        name: ArgoCD Diff
        with:
          argocd-server-url: argocd.example.com
          argocd-token: ${{ secrets.ARGOCD_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          argocd-version: v1.6.1
          argocd-extra-cli-args: --grpc-web
          collapse-diff: false
          timezone: America/Los_Angeles
          timezone-locale: en-US
          diff-tool: diff -N -u
          tracking-label: argocd.argoproj.io/instance

```

## Config we added

```yaml
          # Allows to customize if the Diff should be collapsed in the github comment
          collapse-diff: false
          # Sets Timezone
          timezone: America/Los_Angeles
          # Sets Presentation of the date
          timezone-locale: en-US
          # sets the diff tool which will be used in the argocd diff command
          diff-tool: diff -N -u
          # The tracking label argocd uses to track applications
          tracking-label: argocd.argoproj.io/instance
```
## How it works

1. Downloads the specified version of the ArgoCD binary, and makes it executable
2. Connects to the ArgoCD API using the `argocd-token`, and gets all the apps
3. Filters the apps to the ones that live in the current repo
4. Gets all changed files in the PR
5. Searches in changed or added kustomization.yaml for 
```yaml
labels:
  - pairs:
      argocd.argoproj.io/instance: <argocd-app-name>
```
6. searches in all other changed/added manifests for
```yaml
  labels:
      argocd.argoproj.io/instance: <argocd-app-name>
```
7. Runs `argocd app diff` for each app with changed files, where 5. or 6. is true
8. Posts the diff output as a comment on the PR

## Publishing

Build the script and commit to your branch:
`npm run build && npm run pack`
Commit the build output, and make a PR.
