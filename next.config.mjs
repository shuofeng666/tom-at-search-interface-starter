import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},
  // Pin the workspace root to this project. Without this, Turbopack can
  // mistakenly pick a different lockfile it finds higher up the filesystem
  // (e.g. a stray package-lock.json in the user's home directory) as the
  // root, which breaks module resolution ("Could not find the module ...
  // in the React Client Manifest").
  turbopack: {
    root: projectRoot,
  },
  // /api/search reads data/tom-solutions.csv via fs at runtime. Next's
  // automatic file tracing can't see through the dynamic path.join() used to
  // build that path, so without this it can silently get dropped from a
  // production serverless bundle.
  outputFileTracingIncludes: {
    "/api/search": ["./data/tom-solutions.csv"],
  },
};

export default nextConfig;
