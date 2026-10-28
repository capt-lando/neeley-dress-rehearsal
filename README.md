# Neeley Dress Rehearsal

A presentation practice app for Neeley students. Speak into the microphone, see your words appear live, and request feedback on your delivery, argument, and preparation.

[Open Dress Rehearsal](https://capt-lando.github.io/neeley-dress-rehearsal/)

## Practice

1. Sign in with Google. Microsoft sign-in is supported when configured; this is not an institutionally approved TCU SSO integration.
2. Add talking points, a script, or an optional introduction, transitions, teacher rubric, and assignment instructions.
3. Start recording. Audio streams to OpenAI and draft words appear as you speak. Silence does not end the recording. Pause excludes the break from the recording; Resume continues the same take.
4. Press **Stop** to finish and save the recording and transcript privately. The existing ten-minute recording limit still applies. Replay reuses the saved audio and transcript.
5. Choose **Analyze** when ready for coaching, annotations, and a practice rating. Coaching never starts because you paused speaking.

Audio uploads automatically save and transcribe after file-signature, size, decoding, and duration checks. The server validates the canonical WAV before submitting it. Unsupported, malformed, and oversized audio is rejected. Uploading does not automatically request coaching.

**Cancel and start over** opens a separate confirmation dialog. Confirmation stops capture or processing, closes live transcription, and clears the current take. Saved rehearsals remain in private history. A failed or canceled transcription can be retried against the complete saved recording; partial live text is not treated as a complete transcript.

## Refresh and privacy

Sign-in is remembered across tabs and browser restarts in the same browser profile using Supabase's standard persistent session. It can last beyond 24 hours until you sign out, clear site data, or the provider ends the session. Sign-out updates other open tabs. Private browsing or blocked browser storage can limit persistence. Existing users may need to sign in once after this change from tab-only storage.

Refresh reconnects to an existing transcription or coaching request without submitting it again. Active microphone recordings keep encrypted, half-second audio checkpoints in this browser. After sign-in, the app restores the saved portion of an interrupted take to the same private recording. The microphone remains stopped after refresh; recording cannot continue while the page is closed. The final uncommitted checkpoint can be lost on an abrupt shutdown.

Draft encryption keys are held by the authenticated backend and expire after 24 hours. Browser storage contains encrypted audio and an authenticated manifest, not the key. Account, project, recording, and request identifiers are checked before decryption or recovery. Guessing another recording ID does not grant access. Signing out clears that account's local drafts and releases in-memory keys. Browser storage eviction or unavailable storage can prevent recovery; the app reports checkpoint failures.

Recordings, transcripts, and reports are private to the signed-in account. **My saved rehearsals** can reopen, download, or delete them. Provider credentials remain on the server. Optional analytics contain usage events, not recordings, transcripts, scripts, rubrics, assignment instructions, or chat text.

Luna chat uses the current transcript and preparation, including attached assignment instructions. Selecting a sentence or passage attaches it to the composer; only **Send** requests a reply. Chat stays in the current tab and clears on refresh or sign-out. It is not saved with the report. Assignment directions establish the task requirements; rubric criteria guide feedback priorities. Neither can override the coaching policy or turn planned content into evidence of what was spoken.

## Feedback

The editable policy is `lib/coaching-prompt.md`. The validator rejects invented quotes and overlapping annotations. The /100 rating is practice feedback, not an official course grade. Feedback evaluates spoken content and structure, not eye contact, posture, gestures, slides, volume, or intonation.

Annotations select useful phrases across the full speech while leaving ordinary text unmarked. Soft purple highlights identify connections to the thesis; great and impactful sentences share a gold star, slow sweeping glow, and faint gold outline, while red underlines flag wording that needs work. Click an annotation or its numbered reference to see a brief explanation and, when wording needs improvement, a suggested replacement. Suggestions stay separate from the original transcript. Saved reports keep their original feedback; choose **Update feedback** beside the annotated transcript to request a fresh review, even when the words have not changed.

Speech recognition can omit fillers, repetitions, or false starts. Counts are transcript-based estimates, not a count of every sound or a diagnosis. Review and correct the transcript before analyzing again.

**Add rubric** and **Attach assignment instructions** each accept PDF, DOCX, and TXT files up to 5 MB, with independent previews and text you can review or edit. A real page thumbnail opens into a larger, paginated preview. PDF pages (including scans), Word tables and embedded images, and plain text render locally without AI calls. Word previews approximate Word's layout; unsupported content is identified in the preview. Coaching uses extracted text; scans without readable text need pasted criteria or directions. Original files stay in the current tab and are not uploaded or saved with rehearsals; choose the file again after reloading to restore its preview. Download the annotated transcript or breakdown sheet to keep a separate copy.

Assignment instructions are included in both chat and Analyze. The master prompt uses the stated purpose, audience, required topics, structure, duration, and other relevant requirements to guide planning and feedback, separately from the student's optional script and the teacher's rubric. Conflicting requirements are flagged rather than silently resolved. Feedback stays grounded in the transcript and measured timing, and the practice rating remains separate from a course grade.

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
