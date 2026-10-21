# Neeley Dress Rehearsal

A minimal presentation practice app for Neeley students. Record an English rehearsal, compare it with a script or speaking points, and review word statistics, moments to improve, and thesis/rhetoric coaching.

**Speech recognition needs no Hugging Face account or token.** The public speech model downloads and runs on the device. The standalone website uses the student's OpenAI, Claude, or Gemini API key for coaching. The Codex plugin uses the current conversation for coaching instead, with no separate API key.

## Codex plugin and custom panel

The plugin adds a conversation panel with the same rehearsal interface. **Analyze** stages the complete transcript and preparation inputs, sends a request to the current Codex chat, and waits for Codex to submit the coaching result. The existing validator checks quoted evidence and computes the rating; the panel then renders the report and color annotations. Coaching uses the chat's available model and usage limits, not an API subscription supplied by the student.

To share the plugin, send the single ZIP attached to a [GitHub plugin release](https://github.com/capt-lando/neeley-dress-rehearsal/releases). Recipients extract it and follow `INSTALL.txt`. They need Codex and Node, but do not need pnpm or the source repository. The ZIP is an installable desktop plugin, not a browser link that runs the panel immediately.

Build the installable local package with Node 22.13 or newer and pnpm:

```text
pnpm install --frozen-lockfile
pnpm build:plugin
codex plugin marketplace add ./build/codex-plugin
codex plugin add neeley-dress-rehearsal@neeley-local
```

Reload Codex after installing if the new plugin does not appear, then ask **“Open Neeley Dress Rehearsal.”** Node must be available to the Codex process. The self-contained package is under `build/codex-plugin`; it includes its local marketplace, bundled server, panel, skill, and coaching policy. No dependency installation is needed inside the installed copy. Build output is excluded from source control; GitHub Actions builds it as a downloadable artifact alongside the website.

The local tool connection uses standard input/output, opens no HTTP listener, and makes no paid model requests. Pending inputs and reports are held in bounded process memory and expire. When you choose Analyze, text is shared with the Codex conversation and follows that account's chat retention settings. It is **not** accurate to claim that no data is stored by the host. Original audio stays on the device; browser recording storage is separate from the website and may be unavailable in an embedded panel. Download important recordings.

Microphone access, browser storage, Web Workers and WebAssembly depend on the host's sandbox. The plugin requests microphone permission and handles denial, but a manifest cannot force the host to grant it. The panel keeps a transcript editor available when recording or local recognition is blocked. Speech models download from Hugging Face and the plugin's pinned speech/PDF runtimes download from jsDelivr. The regular website remains available for recording in a full browser.

The native Codex panel was tested with a synthetic transcript: Codex returned a grounded rating, talking-point coverage, and five color annotations, which appeared in the panel. Microphone access was denied by the host/device in that session, so native recording and Whisper transcription remain unverified. Panel exports use the host's download feature and report an error if the host does not support it. All 296 automated tests and the bundled plugin protocol check pass.

Plugin source lives in `plugin/`. Its build reuses `public/` and `lib/`; changes to the coaching wrapper or report logic apply to both editions. Plugin interfaces follow the official [MCP UI guide](https://developers.openai.com/plugins/build/chatgpt-ui), [conversation panel extensions](https://developers.openai.com/plugins/build/extensions), and [desktop plugin packaging](https://developers.openai.com/plugins/deploy/desktop-only). This is a local plugin package, not a public plugin-directory listing.

## Start locally

Install Node.js 22.13 or newer and pnpm. From this folder, install the build dependencies and create the static site:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

After building, Windows users can double-click **Start Dress Rehearsal.cmd** instead of running `pnpm start`. It opens [Dress Rehearsal](http://127.0.0.1:4173). Keep its command window open; press **Ctrl+C** there to stop the preview. The launcher finds Node on PATH or uses the Codex bundled runtime when available.

Node is a build and local-preview tool, not a deployed backend. The launcher runs `preview.mjs`, which serves only `dist/`. The old `server.mjs` and `.env.example` remain as legacy reference/test material; they are not used by the static app. Do not open `public/index.html` directly or launch the old server for this version.

For development, `pnpm dev` starts Vite. Run `pnpm build` again after editing source files before using the preview launcher or publishing.

## Connect your AI

1. Click **Connect API** and choose **ChatGPT (OpenAI)**, **Claude**, or **Gemini**.
2. Follow **Sign in & get a key** to that provider's official API-key page. Sign in, create a key, and copy it.
3. Return to the app, paste the key, and save. Model settings are optional under Advanced.

API use may require billing separate from a chat subscription. The student pays their selected provider for coaching; local speech recognition makes no paid inference request. No site-owner key is embedded. Keys entered here are held only in this tab's memory and clear on refresh or closing the page. A saved key is not verified until an API request succeeds. Leaving a key field blank preserves it; removing the selected coaching key leaves other providers' keys in the tab in place.

## Local speech recognition

Whisper Base is the default, with roughly 77 MB of model weights. The optional Whisper Small uses roughly 249 MB and generally offers better recognition at a higher memory and processing cost. Both are English-only. Runtime files add to these downloads. The browser may remove cached files, so internet is needed on first use or after eviction. Processing time depends on the computer and recording length. See [model choices and sources](MODELS.md).

The app uses Transformers.js 4.3.1 in a worker, with WebGPU where available and a single-thread WebAssembly fallback. No cross-origin-isolation headers are required for the fallback. Try Base or a shorter recording if Small exceeds the device's resources.

Recording starts local transcription automatically. The model downloads if needed and warms up while audio capture continues. Recognition processes eight seconds of new audio at a time, with two seconds of overlap between batches. **Eight seconds is the batch size, not a promised display delay.** Text appears when each batch finishes; the first result can take longer, and a slower computer may build a backlog. Small has run slower than real time in local testing. The transcript is labeled as a draft, with preparation, catching-up, and finishing progress. Check recognition errors and wording at batch boundaries before relying on the feedback.

## Practice

1. Use the **Talking points / Full script** toggle to add either or both in a compact editor. Switching views keeps both fields' contents; both are used automatically when filled. One point per line makes the coverage checklist easier to interpret. Three independent optional sections let you add an **Introduction** under **Make it personal**, custom transitions or phrases under **Add transitions**, and a teacher's rubric under **Add rubric**.
2. Choose your microphone, allow microphone access, and record your presentation. On a first visit, **Detect microphones…** or **Enable mic** requests access and reveals input names. The list refreshes when devices change or you return to the tab. The 32 vertical meter bars respond to measured microphone audio; enabling the mic alone does not record. Draft text appears in batches during recording. **Pause** and **Resume** exclude the break from audio and elapsed speech time; already queued transcription can continue while paused. A take can be up to ten minutes.
3. Stop to save the completed audio in this browser immediately, while any queued transcription and the final short batch finish separately. Wait for **Saved in this browser** before closing the tab. **Replay** is available while transcription finishes; **Analyze** becomes available once the complete transcript is ready and adds coaching only when clicked. Replay and Analyze reuse that transcript without repeating whole-take recognition. Uploaded audio is saved too and is transcribed on Replay or Analyze. Drag the waveform bar to seek anywhere, or use its arrow keys. The playback bars are decorative; transcript word highlighting uses approximate timing.
4. Review the three report sections, inspect the transcript, and correct recognition mistakes before analyzing again.
5. Print or download the breakdown sheet, then practice the suggested improvements.

**Stop live transcript** cancels recognition while audio recording continues. After Stop, **Cancel transcription** stops the remaining queue without deleting the saved audio. If recognition fails or is canceled, partial text is never used as a complete transcript: choose **Transcribe complete recording**, or Analyze, to retry the whole take. Starting a new take, clearing or replacing audio, or changing the speech model cancels old live work and ignores late results. Changing models during recording keeps capture running; retry the complete take after stopping.

**Saved recordings** lists completed takes with their dates and durations. **Open** restores the audio without creating a duplicate; Replay creates a fresh transcript. **Download** saves a WAV outside the app, and **Delete** removes that browser copy. **Clear** only unloads the current player. If storage is full or blocked, the app shows a failure instead of claiming the audio is saved; the audio remains downloadable in this tab, including earlier failed saves listed as unsaved takes. The app never silently deletes older recordings to make space.

Saving happens after Stop or a successful upload, not continuously during a recording. The app requests a browser leave-page warning while a take is recording or a save is pending/failed. This cannot guarantee recovery from a crash or forced shutdown. Local saves belong to the same website address, browser profile, and device; private browsing, clearing site data, or browser storage eviction can remove them. Download important takes for a separate copy.

**Add rubric** accepts PDF, Word (.docx), or text (.txt) files up to 5 MB. PDFs may contain up to 30 pages. The document is read locally in your browser; review and edit the extracted rubric text before analyzing. PDFs with any blank or scanned page are rejected to avoid silently skipping criteria; remove blank pages, use a text-based export, or paste the text. Password-protected PDFs and older .doc files also need an export or pasted text. Extracted rubric text is limited to 40,000 characters; oversized content is rejected rather than silently cut off. Introductions and transitions/phrases each support up to 8,000 characters. Collapsing these optional sections preserves their contents; use Remove to clear a transition or rubric.

Open **View coaching prompt** to inspect and copy the exact prompt assembled from your current transcript, script, talking points, introduction, transitions/phrases, rubric text, and recording duration. Previewing or copying it makes no external API call.

The annotated transcript preserves the original words. Purple marks thesis, green evidence, blue structure, amber visible delivery habits, and rose clarity. Numbered notes explain each highlight. **Download transcript** saves a standalone HTML document with its colors and notes; open it in a browser to print or save a PDF. Correcting text makes the previous annotations stale until you update the feedback.

**Analyze** sends the transcript, script, speaking points, optional introduction, transitions/phrases, rubric text and file name, duration, and measured word statistics directly to the selected AI provider. Audio and the original rubric document stay on the device. Only completed audio and its title, timestamp, duration, size, and format are saved in browser storage. Transcripts, rubrics, preparation text, reports, and API keys remain in tab memory and clear on refresh/close; reports can be downloaded explicitly. Speech-model files may remain cached. The selected AI provider's handling of submitted text follows its API policies. Refreshing clears the current player and connection, while saved audio remains under Saved recordings.

## The coaching wrapper

`lib/coaching-prompt.md` is the shared, editable policy for all AI coaches. It assesses the actual speech independently and keeps target coverage separate from the quality rating. `lib/analysis-core.mjs` adds the response schema and student inputs, validates feedback, and rejects invented quotes or overlapping annotations. Keys never appear in the prompt.

An introduction can be a hook, context, or a personal introduction; a name is not required. Custom introductions, transitions, and phrases guide coaching without requiring word-for-word delivery. Supplied teacher criteria and weights guide feedback priorities, but the app's /100 rating remains an independent coaching estimate, not a course grade. Visual-only criteria such as eye contact, posture, gestures, and slide design are excluded from feedback, recommendations, and scoring. Spoken content and structure remain relevant even when grouped with visuals in the rubric. The coach receives text and measured statistics, so it also cannot judge volume or intonation. Instructions embedded inside uploaded documents cannot override the coaching policy or output format.

The prompt is compiled into the static browser bundle. **Rebuild and redeploy after changing it. Visitors can inspect it; this architecture does not keep it secret.** View coaching prompt shows the exact prompt for the current rehearsal without contacting an AI provider.

## Reading the feedback

Filler and repetition counts reflect the transcript. Speech recognition can omit “um,” “uh,” false starts, and repeated words; these are estimates, not a count of every sound. “Like” can be a normal part of a sentence. Repetitions are not a stutter diagnosis, and pauses or missed points cannot establish that someone forgot their script. Ratings are practice feedback, not an official Neeley grading rubric.

## Publish a static site

The build output in `dist/` is the complete deployable site; it needs no Node or Python server, database, or server-side key. Vite's `base: './'` supports a repository subpath as well as a custom domain, including the speech worker, PDF worker, and WebAssembly runtime. Model files download from Hugging Face rather than being included in the site.

For a free educational GitHub Pages site:

1. Put the project in a public GitHub repository, excluding `.env`, credentials, recordings, generated reports, `node_modules/`, and scratch files. Keep `pnpm-lock.yaml`.
2. In the repository's **Settings → Pages**, choose **GitHub Actions** as the source.
3. The included `.github/workflows/pages.yml` installs the locked dependencies, runs checks, builds with pnpm, and publishes only `dist/`. Push to `main` or run **Actions → Publish static app → Run workflow**. Only the deployment job can publish Pages; neither job can write to repository contents. No deployment secret or personal access token needs to be added to the repository.
4. Wait for the workflow to succeed, then open the HTTPS address shown under **Settings → Pages** and allow microphone access. That address works before buying a domain. [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

When you buy a domain, verify ownership in GitHub, then add the domain under this repository's **Settings → Pages → Custom domain** before pointing its DNS records to GitHub. Follow GitHub's current instructions for your apex domain or `www` subdomain, wait for the certificate, and enable **Enforce HTTPS**. The application does not need a code change. This Actions deployment uses the repository's domain setting; a `CNAME` file is not needed. [Custom-domain setup](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

Browser recordings belong to their website address. Audio saved on localhost or the initial `github.io` address does not automatically appear on a new custom domain; download important recordings before switching addresses. API keys remain temporary in the current tab.

GitHub Pages is free for public repositories but prohibits using it primarily for commercial transactions or commercial SaaS. Choose hosting appropriate to the product if it becomes a paid business. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

Cloudflare Pages offers a free-plan alternative for a static business website, subject to its plan limits and terms. Its free plan has 500 builds per month, a 20,000-file limit, and a 25 MiB limit per file. The current roughly 26.9 MB runtime WASM file exceeds that per-file limit, so asset delivery must be adjusted before deploying there. Only the GitHub Pages workflow is currently prepared. Speech weights remain on Hugging Face. [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

A custom domain is optional and has a separate registration/renewal cost. Static hosting does not cover students' AI API usage. Microphone access requires HTTPS on a published site; localhost is suitable for local preview. [GitHub Pages HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

## Checks and troubleshooting

Run the automated checks with:

```text
pnpm test
```

Use `pnpm build` to check a production build. All 261 automated tests and the production build passed. Browser checks verified physical microphone recording, pause/resume, autosave and reload, plus a completed 599-second Whisper Small transcription. The live transcription test processed a full ten-minute Base recording in 75 batches and finished its remaining queue about three minutes after recording stopped. Small took about 21–24 seconds per batch in this local test, so it does not provide smooth live feedback on the tested machine. Real CPU Whisper Base checks preserved numbers, negation and the ending in a brisk synthetic presentation and exactly matched a separate controlled filler sample. Simulated provider and storage faults verified fallback and recovery, including distinct OpenAI rate, credit, and account-limit errors; they do not establish account access. Browser checks also verified the missing-key setup path without sending a coaching request. Authenticated coaching remains untested, and these checks do not establish universal speech accuracy or processing speed.

If recording is unavailable, open the app at `http://127.0.0.1:4173` in a current Chrome or Edge browser and allow microphone access. If coaching fails, check the named provider's key permissions, credits, and model availability.

Created by: Landon Moustirats
