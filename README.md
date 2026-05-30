# Prompt Library

A browser-based prompt journal for saving, organizing, and reusing AI prompts locally. No server, no dependencies—just HTML, CSS, and vanilla JavaScript with `localStorage`.

---

## Table of contents

1. [What this project does](#1-what-this-project-does)
2. [Project structure](#2-project-structure)
3. [How to run it](#3-how-to-run-it)
4. [Step-by-step: using the app](#4-step-by-step-using-the-app)
5. [Prompt metadata](#5-prompt-metadata)
6. [Notes](#6-notes)
7. [Export and import](#7-export-and-import)
8. [Data storage](#8-data-storage)
9. [Technical details](#9-technical-details)

---

## 1. What this project does

| Feature | Description |
|--------|-------------|
| **Save prompts** | Title, content, model name, and optional “code content” flag |
| **Metadata** | Per-prompt model, timestamps, and token estimates with confidence |
| **Ratings** | 1–5 star effectiveness rating per prompt |
| **Notes** | Private notes attached to each prompt card |
| **Sort** | Newest, highest rated, or unrated first |
| **Copy** | One-click copy of full prompt text |
| **Export / import** | JSON backup with validation, merge options, and rollback on failure |

All data stays in your browser unless you export it.

---

## 2. Project structure

```
Prompt Engineer/
├── index.html    # Page layout, form, list, import modal
├── styles.css    # Dark theme UI (cards, metadata, modal)
├── app.js        # All application logic (IIFE, strict mode)
└── README.md     # This file
```

There is no build step, package manager, or backend.

---

## 3. How to run it

### Option A — Open the file directly

1. Open the project folder on your computer.
2. Double-click `index.html`, or right-click → **Open with** your browser (Chrome, Edge, Firefox, etc.).

### Option B — Local server (recommended for some browsers)

Some browsers restrict certain APIs when opening files via `file://`. If copy or storage behaves oddly, serve the folder locally:

```bash
# Python 3
python -m http.server 8080

# Node (if npx is available)
npx serve .
```

Then visit `http://localhost:8080` (or the port shown in the terminal).

---

## 4. Step-by-step: using the app

### Step 1 — Add a new prompt

1. Under **New prompt**, enter a **Title**.
2. Enter the **Model** you use with this prompt (e.g. `GPT-4o`, `Claude 3.5 Sonnet`). Required, max 100 characters.
3. Paste or write the **Content**.
4. Optionally check **Content is primarily code** for a higher token estimate multiplier.
5. Click **Save prompt**.

The prompt appears in **Saved prompts** with metadata (model, dates, token range).

### Step 2 — Browse and sort

- Each prompt is shown as a **card** with title, metadata, preview, notes, rating, and actions.
- Use the **Sort** dropdown:
  - **Newest first** — by metadata `createdAt` (descending)
  - **Highest rated** — by star rating
  - **Unrated first** — unrated prompts first, then by rating

### Step 3 — Copy a prompt

- Click the **copy** icon on a card header.
- Full prompt content is copied to the clipboard (with a fallback for older browsers).

### Step 4 — Rate effectiveness

- Use the **Rate** stars on a card (1–5).
- Click the same star again to clear the rating.
- Keyboard: focus the star row, then arrow keys, Home/End, or Escape to clear.

### Step 5 — Add notes

1. On a card, open the **Notes** section.
2. Click **Add note** or **Edit**, write text, then **Save**.
3. **Delete** removes the note (with confirmation).

### Step 6 — Delete a prompt

- Click **Delete** on the card. The prompt and its note are removed from storage.

---

## 5. Prompt metadata

Every saved prompt includes a **metadata** object created when you save (or backfilled for older entries).

### Schema (per prompt)

```json
{
  "model": "GPT-4o",
  "createdAt": "2026-05-30T12:00:00.000Z",
  "updatedAt": "2026-05-30T12:00:00.000Z",
  "tokenEstimate": {
    "min": 42,
    "max": 120,
    "confidence": "high"
  }
}
```

| Field | Rules |
|-------|--------|
| `model` | Non-empty string, max 100 characters |
| `createdAt` / `updatedAt` | ISO 8601: `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `tokenEstimate.min` | `0.75 × word_count` (×1.3 if code) |
| `tokenEstimate.max` | `0.25 × character_count` (×1.3 if code) |
| `confidence` | `high` (&lt;1000 est.), `medium` (1000–5000), `low` (&gt;5000) |

### UI on each card

- **Model** name (accent color)
- **Created / updated** in human-readable locale format
- **Token range** with a color-coded confidence badge (green / yellow / red)

### Core functions (in `app.js`)

- `trackModel(modelName, content)` — create metadata for a new prompt
- `updateTimestamps(metadata)` — refresh `updatedAt` (must be ≥ `createdAt`)
- `estimateTokens(text, isCode)` — compute min, max, and confidence

Invalid inputs throw descriptive errors; the UI uses `try/catch` where needed.

---

## 6. Notes

Notes are stored separately from prompts, keyed by `promptId`:

| Storage key | Value |
|-------------|--------|
| `promptNotes` | Object: `{ [promptId]: { id, promptId, body, updatedAt } }` |

Notes are included in **export** files and restored on **import** according to the chosen merge mode.

---

## 7. Export and import

### Step 1 — Export

1. Click **Export** in the header.
2. The app:
   - Loads all prompts from `localStorage`
   - Validates each prompt and its metadata
   - Computes statistics
   - Downloads a JSON file: `prompt-library-export-<timestamp>.json`

If validation fails, you get an alert with specific errors and no file is downloaded.

### Step 2 — Export file format

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-05-30T12:00:00.000Z",
  "statistics": {
    "totalPrompts": 10,
    "averageRating": 4.2,
    "mostUsedModel": "GPT-4o"
  },
  "prompts": [
    {
      "id": "p_…",
      "title": "…",
      "content": "…",
      "myRating": 4,
      "ratedAt": "2026-05-30T12:00:00.000Z",
      "metadata": { }
    }
  ],
  "notes": {
    "p_…": { "id": "n_…", "promptId": "p_…", "body": "…", "updatedAt": 1234567890 }
  }
}
```

| Field | Purpose |
|-------|---------|
| `schemaVersion` | Compatibility (`1` only for import today) |
| `exportedAt` | When the backup was created |
| `statistics` | Summary for quick inspection |
| `prompts` | Full library with metadata |
| `notes` | Optional notes map by prompt ID |

### Step 3 — Import

1. Click **Import** and choose a `.json` export file.
2. The file is parsed and validated (schema version, prompt shape, duplicate IDs inside the file).
3. If any prompt IDs already exist locally, the **import modal** lists conflicts and asks how to proceed.

### Step 4 — Merge options

| Mode | Behavior |
|------|----------|
| **Merge — keep existing** | Add new prompts only; skip imports whose `id` already exists locally |
| **Merge — overwrite duplicates** | Imported prompt wins on ID clash; others are added |
| **Replace all** | Deletes all current prompts and notes, then imports the file (extra confirmation) |

Notes follow the same strategy (skip, overwrite, or replace per mode).

### Step 5 — Safety and errors

Before writing imported data:

1. A **backup** of `promptLibrary` and `promptNotes` is saved to `sessionStorage`.
2. If saving fails, the app **rolls back** to the backup and shows an error in the modal.
3. On success, the backup is cleared and the list re-renders.

Common errors (shown in alerts or the modal):

- Invalid or unsupported `schemaVersion`
- Malformed JSON
- Missing/invalid metadata or ISO dates
- Duplicate IDs inside the import file
- Storage quota exceeded

---

## 8. Data storage

Everything is stored in the browser **localStorage** (and a temporary import backup in **sessionStorage**).

| Key | Contents |
|-----|----------|
| `promptLibrary` | Array of prompt objects |
| `promptNotes` | Notes object keyed by `promptId` |
| `promptLibrary_importBackup` | Session-only snapshot during import (cleared on success) |

**Important:** Clearing site data or using a different browser/profile removes your library unless you have an export file.

### Prompt object (in storage)

```json
{
  "id": "p_<timestamp36>_<random>",
  "title": "My prompt",
  "content": "Full prompt text…",
  "myRating": null,
  "ratedAt": null,
  "metadata": { }
}
```

Older prompts without metadata get **backfilled** on load using the ID timestamp and `"Unknown"` as the model name.

---

## 9. Technical details

| Topic | Choice |
|-------|--------|
| **Stack** | Pure HTML / CSS / JavaScript (ES5-style IIFE, `"use strict"`) |
| **Dependencies** | None |
| **Persistence** | `localStorage` + `sessionStorage` (import backup) |
| **Export** | `Blob` + temporary `<a download>` |
| **Import** | `FileReader` + JSON parse + validation pipeline |

### Browser support

Works in modern browsers that support:

- `localStorage`
- `JSON`
- `Blob` / `URL.createObjectURL`
- `navigator.clipboard` (optional; fallback uses `document.execCommand('copy')`)

### Accessibility

- ARIA labels on ratings, copy, notes, and the import dialog
- Keyboard support for star ratings and Escape to close the import modal

---

## Quick reference

| Action | Where |
|--------|--------|
| Save prompt | New prompt form → **Save prompt** |
| Export backup | Header → **Export** |
| Import backup | Header → **Import** |
| Sort library | Saved prompts → **Sort** dropdown |
| Copy text | Card → copy icon |
| Rate prompt | Card → stars |

---

## License

This project is provided as-is for local personal use. Add a license file here if you plan to distribute or open-source it.
