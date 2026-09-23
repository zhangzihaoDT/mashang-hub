export function isAllowedArtifactPath(relativePath, roots = ["outputs", "mashang_workspace/outputs"]) {
  return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}
