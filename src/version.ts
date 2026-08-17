/**
 * Reel's version, in one place.
 *
 * It is part of the render fingerprint (a new Reel may render differently, so
 * `--if-changed` must not skip on it) and it is what the GitHub Action installs
 * from npm by default, so a pinned action tag is a pinned tool. Two copies of
 * it means one of them is wrong; a test asserts this one matches package.json.
 */
export const VERSION = "0.2.0";
