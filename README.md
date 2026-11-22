# Mathesis Teacher

A small web app for a mathematics teacher to upload, title, tag and organize lesson videos.
It runs on your own computer. Videos never leave it.

## Run it

1. Install Node.js 18 or newer from https://nodejs.org (one time only).
2. Open a terminal in this folder and run:

   ```
   npm start
   ```

3. Open http://localhost:3000 in your browser.
4. The first time, it asks you to create a teacher password. Only you need it; students never log in.

There is nothing to install with npm: the app uses only what comes with Node.js.

## What it does

- Add a lesson by pasting a YouTube link. Upload the video to YouTube as **Unlisted** first, so only people
  with the link can find it (Private videos will not play). The app fills in the title from YouTube and
  plays the video inside the app, using YouTube's privacy-enhanced player (youtube-nocookie.com).
- Or upload a video file directly (useful when running on your own computer). A progress bar shows the upload.
- Every lesson gets a title, description, class, topics and folder.
- Classes: Class VI to Class XII and BSc Mathematics.
- Topics are free tags such as "Fractions" or "Calculus". Earlier topics are suggested as you type.
- Folders group videos, for example by chapter or by course. Deleting a folder keeps its videos.
- Browse by folder, class or topic, search, and sort by date or title.
- Click a video to watch it, edit its details, hide it from students, or delete it.
- Teacher login protects every change. You stay logged in for 14 days on each device.
  Change the password from the top bar; doing so logs out your other devices.

## Where things are stored

Everything lives in the `data/` folder next to this file:

- `data/videos/` holds the video files.
- `data/library.json` holds titles, topics, folders and the other details.
- `data/auth.json` holds the scrambled (hashed) teacher password. It never stores the password itself.

Back up the `data/` folder to keep your library. Settings you can change when starting:

- `PORT=4000 npm start` to use another port.
- `MAX_UPLOAD_MB=4096 npm start` to raise the upload limit (default 2048 MB).
- `DATA_DIR=/path/to/folder npm start` to store videos elsewhere.
- `TEACHER_PASSWORD=... npm start` to set the password from outside (use this when hosting).
- `YOUTUBE_OEMBED_URL` changes where YouTube titles are looked up (only needed for tests).

## Putting it online

When the app runs on a hosting service, set these on the host:

- `TEACHER_PASSWORD`: your password. The "create password" screen only appears on the
  computer running the server, so nobody on the internet can claim a fresh install.
- `DATA_DIR`: a folder on a persistent disk, so videos survive restarts and redeploys.
- Serve it over HTTPS (hosting services do this for you). The login cookie is then marked secure.

Wrong passwords are limited to 5 tries per 15 minutes from one address.

## For the student app

The student app can read the library from this server:

- `GET /api/videos?published=true` lists visible videos (also takes `level`, `topic`, `folder`, `q`, `sort`).
- `GET /api/videos/:id`, `GET /api/folders`, `GET /api/levels`, `GET /api/topics`.
- Each video has a `source`: `"youtube"` videos have `youtubeId`, `embedUrl`, `watchUrl` and `thumbnailUrl`;
  `"file"` videos have a `url` such as `/media/<file>.mp4` that streams with seeking support.

Students need no login. They only ever see videos marked "Visible to students": hidden videos
do not appear in any list, and their files cannot be opened without the teacher login.
Every change (upload, edit, delete, folders) needs the teacher login.

## Tests

```
npm test
```
