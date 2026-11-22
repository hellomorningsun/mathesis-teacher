# Mathesis Teacher

A web app for a mathematics teacher to organize lesson videos for students.
Videos live on YouTube (as **Unlisted**); this app keeps the library: titles, descriptions,
classes (Class VI to XII and BSc Mathematics), topics and folders. It runs for free on Cloudflare.

## What it does

- Add a lesson by pasting a YouTube link. The app checks the link, fills in the title from YouTube,
  and plays the lesson inside the app with YouTube's privacy-enhanced player.
- Give each lesson a class, topics such as "Fractions", a folder and a description.
- Browse by folder, class or topic, search, and sort by date or title.
- Hide a lesson from students without deleting it.
- Teacher login protects every change. Students never log in and only see visible lessons.

## Put it online with Cloudflare (free, no terminal needed)

You do these steps once. Each takes a minute or two.

1. **Create a Cloudflare account** at https://dash.cloudflare.com/sign-up (the Free plan is enough).
2. **Create the database.** In the Cloudflare dashboard open **Storage & databases → D1 SQL database →
   Create database**. Name it `mathesis` and create it. Copy its **Database ID** (a long code like
   `1a2b3c4d-…`).
3. **Paste the ID into the code.** On GitHub, open `wrangler.jsonc` in this repository, click the pencil
   icon, replace `00000000-0000-0000-0000-000000000000` with your Database ID, and commit.
4. **Connect the repository.** In Cloudflare open **Compute (Workers) → Workers & Pages → Create →
   Import a repository**, connect GitHub, and pick `mathesis-teacher`. When asked:
   - Project name: `mathesis-teacher`
   - Deploy command: `npm run deploy`

   Click **Deploy**. The first deploy also creates the database tables.
5. **Set your password.** Open the new Worker → **Settings → Variables and secrets → Add**. Type
   `Secret`, name `TEACHER_PASSWORD`, value: the password you want. Save (and deploy if asked).
6. **Open your app** at the address Cloudflare shows, like `https://mathesis-teacher.<your-name>.workers.dev`,
   and log in with that password.

From then on, every change committed to GitHub is published automatically.
To change the password, edit the `TEACHER_PASSWORD` secret; that logs out every device.

## Run it on your own computer (optional)

Needs Node.js 20 or newer from https://nodejs.org.

```
npm install
cp .dev.vars.example .dev.vars      # then put your own password in .dev.vars
npm run setup:local
npm run dev
```

Open http://localhost:8787.

## Tests

```
npm install
npm test
```

The tests run the real app on a local copy of Cloudflare.

## For the student app

The student app reads the library from this app, with no login:

- `GET /api/videos` lists visible lessons. Filters: `level`, `topic`, `folder`, `q`, `sort`.
- `GET /api/videos/:id`, `GET /api/folders`, `GET /api/levels`, `GET /api/topics`.
- Each lesson has `youtubeId`, `embedUrl`, `watchUrl` and `thumbnailUrl`.

Hidden lessons never appear to students. Every change needs the teacher login.
Wrong passwords are limited to 5 tries per 15 minutes from one address.
