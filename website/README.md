# DevOpsIndex

Static documentation website for the DevOps reference notes. Built with Astro 6 + Tailwind CSS + Mermaid.

## Run locally

```bash
cd website/
npm install
npm run dev      # syncs content + starts dev server at localhost:4321
```

## Build

```bash
npm run build    # syncs content + builds static site to dist/
npm run preview  # preview the built site
```

## Interactive content

Topic markdown can embed click-to-reveal quizzes, tabs, step-through
walkthroughs, and compare toggles — no per-page script needed, they're wired
up once site-wide. See [COMPONENTS.md](./COMPONENTS.md) for the HTML syntax
and where to reach for which component. `databases/kafka-field-guide.md` is
the reference example.

## How content works

`scripts/sync-content.js` runs before every dev/build. It:
1. Scans all 16 topic sections in the parent devops repo
2. Copies markdown files into `src/data/topics/` (with mermaid syntax fixes applied)
3. Generates JSON manifest files in `src/content/topics/` (one per page)
4. Astro uses these to generate ~124 static pages

The `src/data/topics/` and `src/content/topics/` directories are git-ignored — they're rebuilt on every run.

## Deploy to Vercel

1. Push the devops repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import repo
3. Set **Root Directory** to `website`
4. Vercel auto-detects Astro → deploy

Or via CLI from the `website/` directory:
```bash
npx vercel --prod
```
