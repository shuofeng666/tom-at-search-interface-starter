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
};

export default nextConfig;
