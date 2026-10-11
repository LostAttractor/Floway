if (process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Repository-wide verification may run only in GitHub Actions. Select the files, test paths, or TypeScript projects relevant to the change.');
}
