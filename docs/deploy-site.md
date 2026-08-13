# Deploying the site

Reel ships as two surfaces built from one Next.js app in `studio/`:

| Surface | What it is | How it runs |
|---|---|---|
| **The site** | The landing page — what Reel is, what it renders, how to install it | Static, deployed to Vercel or any static host |
| **Studio** | The workspace: author, edit, record, browse | Local only, launched by `reel ui` |

Studio is not deployable, and that is deliberate. It drives a real browser
(Chromium, ~344 MB), shells out to ffmpeg (~44 MB), executes the spec's
`run.cmd`, and reads and writes the workspace on disk. Even setting the
serverless limits aside, the app it records is on the visitor's machine — a
hosted instance has no route to their `localhost`. So the deployed build
answers the workspace routes with an install command instead.

## Deploying to Vercel

Import the repository, then set:

| Setting | Value |
|---|---|
| Root Directory | `studio` |
| Framework preset | Next.js (detected) |
| Build command | *(default)* |
| Environment variable | `NEXT_PUBLIC_REEL_SITE` = `1` |
| Environment variable | `NEXT_PUBLIC_SITE_URL` = your production origin |

`NEXT_PUBLIC_REEL_SITE` is what separates the two builds. With it set:

- `/` renders the landing page, and its calls to action become the install
  command rather than links into a local app,
- `/author`, `/studio`, `/gallery` and `/settings` render "Studio runs on your
  machine" instead of an app shell that would fail on its first API call.

Without it, the same code builds the local app that `reel ui` serves.

`NEXT_PUBLIC_SITE_URL` is optional but worth setting. It becomes the canonical
link and `og:url`. Left unset, the build falls back to Vercel's
`VERCEL_PROJECT_PRODUCTION_URL` — correct, but it means a custom domain added
later won't be reflected until the next deploy.

## Media

The landing page's media lives in `studio/public/demo/` and is committed, so
the site builds on a clean checkout with no render step. That matters beyond
deployment: these files are also what a fresh `git clone` shows, and the
`examples/*/out/` originals are git-ignored.

To refresh them after changing a demo:

```sh
npm run reel -- record examples/taskflow/demo.reel.yaml
npm run reel -- record examples/cli/demo.reel.yaml
cp examples/taskflow/out/taskflow.gif           studio/public/demo/taskflow.gif
cp examples/taskflow/out/taskflow.mp4           studio/public/demo/taskflow.mp4
cp examples/cli/out/cli.gif                     studio/public/demo/cli.gif
cp examples/taskflow/out/storyboard/01-done.png studio/public/demo/storyboard.png
```

The Studio screenshots (`studio-*.png`) are captured by hand from a running
`reel ui`; refresh them when the UI changes materially.

## Checking the site build locally

```sh
cd studio
NEXT_PUBLIC_REEL_SITE=1 npx next build
NEXT_PUBLIC_REEL_SITE=1 npx next start -p 4599
```

Then confirm `/` is the landing page and `/studio` is the install notice. Build
without the variable to get the local app back.
