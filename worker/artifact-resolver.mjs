import { realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { isAllowedArtifactPath } from "./artifact-policy.mjs";

const ARTIFACT_TYPES = {
  ".md": ["Markdown", "text/markdown"],
  ".html": ["HTML", "text/html"],
  ".csv": ["CSV", "text/csv"],
  ".png": ["PNG", "image/png"],
};

function isMissingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

export async function resolveLocalArtifact(path, projectRoot, allowedRoots = ["outputs", "mashang_workspace/outputs"]) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.split("/").some((part) => part === "..")) return null;

  const root = await realpath(projectRoot);
  const candidate = path.startsWith("/") ? resolve(path) : resolve(root, path);
  const candidatePath = relative(root, candidate);
  if (!candidatePath || candidatePath.startsWith("..") || candidatePath.startsWith("/")) return null;

  // Only output paths can be downloadable artifacts. Check before realpath so
  // prose that mentions a dataset filename never triggers filesystem lookup.
  if (!isAllowedArtifactPath(candidatePath, allowedRoots)) return null;

  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }

  const canonicalPath = relative(root, canonical);
  if (!canonicalPath || canonicalPath.startsWith("..") || canonicalPath.startsWith("/")) return null;
  if (!isAllowedArtifactPath(canonicalPath, allowedRoots)) return null;

  const extension = extname(canonical).toLowerCase();
  const type = ARTIFACT_TYPES[extension];
  if (!type) return null;

  let details;
  try {
    details = await stat(canonical);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  if (!details.isFile() || details.size > 20 * 1024 * 1024) return null;

  return {
    file: canonical,
    path: canonicalPath,
    name: basename(canonical),
    extension,
    type: type[0],
    mimeType: type[1],
    size: details.size,
  };
}
