# Neeley Dress Rehearsal

A presentation practice app for Neeley students. Speak into the microphone, see your words appear live, and request feedback on your delivery, argument, and preparation.

[Open Dress Rehearsal](https://capt-lando.github.io/neeley-dress-rehearsal/)

## Practice

1. Sign in with Google. Microsoft sign-in is supported when configured; this is not an institutionally approved TCU SSO integration.
2. Add talking points, a script, or an optional introduction, transitions, and teacher rubric.
3. Start recording. Audio streams to OpenAI and draft words appear as you speak. Silence does not end the recording. Pause excludes the break from the recording; Resume continues the same take.
4. Press **Stop** to finish and save the recording and transcript privately. The existing ten-minute recording limit still applies. Replay reuses the saved audio and transcript.
5. Choose **Analyze** when ready for coaching, annotations, and a practice rating. Coaching never starts because you paused speaking.

Audio uploads automatically save and transcribe after file-signature, size, decoding, and duration checks. The server validates the canonical WAV before submitting it. Unsupported, malformed, and oversized audio is rejected. Uploading does not automatically request coaching.

**Cancel and start over** opens a separate confirmation dialog. Confirmation stops capture or processing, closes live transcription, and clears the current take. Saved rehearsals remain in private history. A failed or canceled transcription can be retried against the complete saved recording; partial live text is not treated as a complete transcript.

## Refresh and privacy

Refresh reconnects to an existing transcription or coaching request without submitting it again. Active microphone recordings keep encrypted, half-second audio checkpoints in this browser. After sign-in, the app restores the saved portion of an interrupted take to the same private recording. The microphone remains stopped after refresh; recording cannot continue while the page is closed. The final uncommitted checkpoint can be lost on an abrupt shutdown.

Draft encryption keys are held by the authenticated backend and expire after 24 hours. Browser storage contains encrypted audio and an authenticated manifest, not the key. Account, project, recording, and request identifiers are checked before decryption or recovery. Guessing another recording ID does not grant access. Signing out clears that account's local drafts and releases in-memory keys. Browser storage eviction or unavailable storage can prevent recovery; the app reports checkpoint failures.

Recordings, transcripts, and reports are private to the signed-in account. **My saved rehearsals** can reopen, download, or delete them. Provider credentials remain on the server. Optional analytics contain usage events, not recordings, transcripts, scripts, rubrics, or chat text.

Luna chat uses the current transcript and preparation. Selecting a sentence or passage attaches it to the composer; only **Send** requests a reply. Chat stays in the current tab and clears on refresh or sign-out. It is not saved with the report. Preparation and rubric content are treated as inputs, not instructions that can override the coaching policy.

## Feedback

The editable policy is `lib/coaching-prompt.md`. The validator rejects invented quotes and overlapping annotations. The /100 rating is practice feedback, not an official course grade. Feedback evaluates spoken content and structure, not eye contact, posture, gestures, slides, volume, or intonation.

Speech recognition can omit fillers, repetitions, or false starts. Counts are transcript-based estimates, not a count of every sound or a diagnosis. Review and correct the transcript before analyzing again.

Rubrics accept PDF, DOCX, and TXT files up to 5 MB. A real page thumbnail opens into a larger, paginated preview. PDF pages (including scans), Word tables and embedded images, and plain text render locally without AI calls. Word previews approximate Word's layout; unsupported content is identified in the preview. Coaching still uses extracted text, available under **Paste or review rubric text**. Scans without readable text need pasted criteria. Original files stay in the current tab and are not uploaded or saved with rehearsals; choose the file again after reloading to restore its preview. Download the annotated transcript or breakdown sheet to keep a separate copy.

## Development

Use Node 22.13 or newer and pnpm. Copy the public settings from `.env.example` into ignored `.env.local`; the website requires its hosted backend.

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm start
```

Windows users can open **Start Dress Rehearsal.cmd** after building. The preview serves only `dist/` at `http://127.0.0.1:4173`. Use `pnpm dev` for development. Published microphone access requires HTTPS.

The application uses GitHub Pages, Supabase identity/private storage/an authenticated API, and OpenAI speech and coaching. There is no local speech-model download or separately hosted GPU worker. The browser sends short PCM frames immediately. Connection renewal is internal and never ends the user's recording.

See [deployment and verification](docs/cloud-pilot.md), [backend setup](supabase/README.md), [cost assumptions](docs/cloud-costs.md), and [project direction](PROJECT-DIRECTION.md).

## Deployment

Apply database migrations and deploy `rehearsal-api` before publishing a client that requires them. Run the Node tests and production build. Pushing `main` runs `.github/workflows/pages.yml`, which publishes only `dist/`; the separate pilot workflow also checks database migrations and security tests. Set the two public Supabase repository variables documented in `.env.example`. Never put a provider key in a `VITE_` variable.

The existing [Codex plugin release 0.2.1](https://github.com/capt-lando/neeley-dress-rehearsal/releases) remains available and is not rebuilt by website releases. Current source retains the text coaching tools; the retired local speech panel and its packaging pipeline have been removed.

Created by Landon Moustirats.
