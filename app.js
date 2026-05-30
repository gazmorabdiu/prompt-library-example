(function () {
  "use strict";

  var STORAGE_KEY = "promptLibrary";
  var NOTES_STORAGE_KEY = "promptNotes";
  var BACKUP_SESSION_KEY = "promptLibrary_importBackup";
  var EXPORT_SCHEMA_VERSION = 1;
  var SUPPORTED_IMPORT_VERSIONS = [1];
  var PREVIEW_WORD_COUNT = 8;
  var noteEditIds = {};
  var pendingImport = null;

  var form = document.getElementById("prompt-form");
  var titleInput = document.getElementById("prompt-title");
  var modelInput = document.getElementById("prompt-model");
  var contentInput = document.getElementById("prompt-content");
  var isCodeInput = document.getElementById("prompt-is-code");
  var listEl = document.getElementById("prompt-list");
  var emptyState = document.getElementById("empty-state");
  var sortSelect = document.getElementById("sort-select");
  var btnExport = document.getElementById("btn-export");
  var btnImport = document.getElementById("btn-import");
  var importFileInput = document.getElementById("import-file");
  var importModal = document.getElementById("import-modal");
  var importModalSummary = document.getElementById("import-modal-summary");
  var importModalDuplicates = document.getElementById("import-modal-duplicates");
  var importModalError = document.getElementById("import-modal-error");
  var importCancelBtn = document.getElementById("import-cancel");
  var importConfirmBtn = document.getElementById("import-confirm");

  var ISO_8601_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function isValidIso8601(value) {
    if (typeof value !== "string" || !ISO_8601_RE.test(value)) return false;
    var d = new Date(value);
    return !isNaN(d.getTime()) && d.toISOString() === value;
  }

  function validateModelName(modelName) {
    if (typeof modelName !== "string") {
      throw new Error("Model name must be a non-empty string.");
    }
    var trimmed = modelName.trim();
    if (!trimmed) {
      throw new Error("Model name must be a non-empty string.");
    }
    if (trimmed.length > 100) {
      throw new Error("Model name must be at most 100 characters.");
    }
    return trimmed;
  }

  function wordCount(text) {
    var trimmed = (text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
  }

  function estimateTokens(text, isCode) {
    if (typeof text !== "string") {
      throw new Error("Text for token estimation must be a string.");
    }
    if (typeof isCode !== "boolean") {
      throw new Error("isCode must be a boolean.");
    }
    var chars = text.length;
    var words = wordCount(text);
    var min = 0.75 * words;
    var max = 0.25 * chars;
    if (isCode) {
      min *= 1.3;
      max *= 1.3;
    }
    min = Math.round(min);
    max = Math.round(max);
    var midpoint = (min + max) / 2;
    var confidence = "high";
    if (midpoint > 5000) confidence = "low";
    else if (midpoint >= 1000) confidence = "medium";
    return { min: min, max: max, confidence: confidence };
  }

  function nowIso8601() {
    return new Date().toISOString();
  }

  function trackModel(modelName, content) {
    var model = validateModelName(modelName);
    if (typeof content !== "string") {
      throw new Error("Content must be a string for metadata tracking.");
    }
    var createdAt = nowIso8601();
    var isCode = detectCodeContent(content);
    var tokenEstimate = estimateTokens(content, isCode);
    return {
      model: model,
      createdAt: createdAt,
      updatedAt: createdAt,
      tokenEstimate: tokenEstimate,
    };
  }

  function updateTimestamps(metadata) {
    if (!metadata || typeof metadata !== "object") {
      throw new Error("Metadata must be a valid metadata object.");
    }
    if (!isValidIso8601(metadata.createdAt)) {
      throw new Error(
        "createdAt must be a valid ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ).",
      );
    }
    var updatedAt = nowIso8601();
    if (new Date(updatedAt).getTime() < new Date(metadata.createdAt).getTime()) {
      throw new Error("updatedAt must be greater than or equal to createdAt.");
    }
    return {
      model: metadata.model,
      createdAt: metadata.createdAt,
      updatedAt: updatedAt,
      tokenEstimate: metadata.tokenEstimate,
    };
  }

  function detectCodeContent(text) {
    if (!text || typeof text !== "string") return false;
    if (/```[\s\S]*?```/.test(text)) return true;
    if (
      /^\s*(function|const|let|var|import|class|def |public |#include)/m.test(
        text,
      )
    ) {
      return true;
    }
    var symbols = (text.match(/[{}();[\]=<>]/g) || []).length;
    return symbols > Math.max(8, text.length * 0.05);
  }

  function createdAtFromPromptId(promptId) {
    if (!promptId || typeof promptId !== "string") return nowIso8601();
    var parts = promptId.split("_");
    if (parts.length >= 2 && parts[0] === "p") {
      var ms = parseInt(parts[1], 36);
      if (!isNaN(ms) && ms > 0) {
        var iso = new Date(ms).toISOString();
        if (isValidIso8601(iso)) return iso;
      }
    }
    return nowIso8601();
  }

  function backfillMetadata(content, promptId) {
    var contentStr = typeof content === "string" ? content : "";
    var createdAt = createdAtFromPromptId(promptId);
    var isCode = detectCodeContent(contentStr);
    return {
      model: "Unknown",
      createdAt: createdAt,
      updatedAt: createdAt,
      tokenEstimate: estimateTokens(contentStr, isCode),
    };
  }

  function normalizeMetadata(raw, contentFallback, promptId) {
    if (raw && typeof raw === "object" && isValidIso8601(raw.createdAt)) {
      try {
        validateModelName(raw.model);
      } catch (e) {
        return backfillMetadata(contentFallback, promptId);
      }
      var updatedAt =
        raw.updatedAt && isValidIso8601(raw.updatedAt)
          ? raw.updatedAt
          : raw.createdAt;
      if (new Date(updatedAt).getTime() < new Date(raw.createdAt).getTime()) {
        updatedAt = raw.createdAt;
      }
      var te = raw.tokenEstimate;
      var tokenEstimate =
        te &&
        typeof te.min === "number" &&
        typeof te.max === "number" &&
        (te.confidence === "high" ||
          te.confidence === "medium" ||
          te.confidence === "low")
          ? {
              min: te.min,
              max: te.max,
              confidence: te.confidence,
            }
          : estimateTokens(
              contentFallback || "",
              detectCodeContent(contentFallback || ""),
            );
      return {
        model: raw.model.trim(),
        createdAt: raw.createdAt,
        updatedAt: updatedAt,
        tokenEstimate: tokenEstimate,
      };
    }
    return backfillMetadata(contentFallback, promptId);
  }

  function formatHumanDate(iso) {
    try {
      if (!isValidIso8601(iso)) return "—";
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch (e) {
      return "—";
    }
  }

  function formatTokenRange(estimate) {
    if (!estimate) return "—";
    return estimate.min + "–" + estimate.max + " tokens";
  }

  function loadPrompts() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizePrompt);
    } catch (e) {
      return [];
    }
  }

  function savePrompts(prompts) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
      return { ok: true };
    } catch (e) {
      var msg = "Could not save prompts to local storage.";
      if (e && (e.name === "QuotaExceededError" || e.code === 22)) {
        msg = "Storage quota exceeded while saving prompts.";
      } else if (e && e.message) {
        msg = msg + " " + e.message;
      }
      return { ok: false, message: msg };
    }
  }

  function validateTokenEstimate(te, path) {
    var prefix = path || "tokenEstimate";
    if (!te || typeof te !== "object") {
      return prefix + " must be an object with min, max, and confidence.";
    }
    if (typeof te.min !== "number" || typeof te.max !== "number") {
      return prefix + " must include numeric min and max values.";
    }
    if (
      te.confidence !== "high" &&
      te.confidence !== "medium" &&
      te.confidence !== "low"
    ) {
      return prefix + " confidence must be high, medium, or low.";
    }
    return null;
  }

  function validateMetadataObject(meta, path) {
    var base = path || "metadata";
    if (!meta || typeof meta !== "object") {
      return base + " must be an object.";
    }
    try {
      validateModelName(meta.model);
    } catch (e) {
      return base + ".model: " + (e && e.message ? e.message : "invalid model.");
    }
    if (!isValidIso8601(meta.createdAt)) {
      return (
        base +
        ".createdAt must be a valid ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ)."
      );
    }
    if (!isValidIso8601(meta.updatedAt)) {
      return (
        base +
        ".updatedAt must be a valid ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ)."
      );
    }
    if (
      new Date(meta.updatedAt).getTime() <
      new Date(meta.createdAt).getTime()
    ) {
      return base + ".updatedAt must be greater than or equal to createdAt.";
    }
    var teErr = validateTokenEstimate(meta.tokenEstimate, base + ".tokenEstimate");
    if (teErr) return teErr;
    return null;
  }

  function validatePromptIntegrity(prompt, indexLabel) {
    var label = indexLabel != null ? "Prompt " + indexLabel : "Prompt";
    var errors = [];
    if (!prompt || typeof prompt !== "object") {
      return [label + " must be an object."];
    }
    if (typeof prompt.id !== "string" || !prompt.id.trim()) {
      errors.push(label + ' must have a non-empty string "id".');
    }
    if (typeof prompt.title !== "string") {
      errors.push(label + ' must have a string "title".');
    }
    if (typeof prompt.content !== "string") {
      errors.push(label + ' must have a string "content".');
    }
    if (
      prompt.myRating != null &&
      (typeof prompt.myRating !== "number" ||
        prompt.myRating < 1 ||
        prompt.myRating > 5 ||
        prompt.myRating !== Math.floor(prompt.myRating))
    ) {
      errors.push(label + ' "myRating" must be null or an integer from 1 to 5.');
    }
    if (prompt.ratedAt != null && !isValidIso8601(prompt.ratedAt)) {
      errors.push(
        label +
          ' "ratedAt" must be null or a valid ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ).',
      );
    }
    if (prompt.metadata) {
      var metaErr = validateMetadataObject(prompt.metadata, label + " metadata");
      if (metaErr) errors.push(metaErr);
    } else {
      errors.push(label + " must include metadata.");
    }
    return errors;
  }

  function serializePromptForExport(prompt) {
    var normalized = normalizePrompt(prompt);
    var errors = validatePromptIntegrity(normalized, normalized.id || "?");
    if (errors.length) {
      throw new Error(errors.join(" "));
    }
    return {
      id: normalized.id,
      title: normalized.title,
      content: normalized.content,
      myRating: normalized.myRating,
      ratedAt: normalized.ratedAt,
      metadata: {
        model: normalized.metadata.model,
        createdAt: normalized.metadata.createdAt,
        updatedAt: normalized.metadata.updatedAt,
        tokenEstimate: {
          min: normalized.metadata.tokenEstimate.min,
          max: normalized.metadata.tokenEstimate.max,
          confidence: normalized.metadata.tokenEstimate.confidence,
        },
      },
    };
  }

  function computeExportStatistics(prompts) {
    var totalPrompts = prompts.length;
    var rated = prompts.filter(function (p) {
      return p.myRating != null && p.myRating >= 1 && p.myRating <= 5;
    });
    var averageRating = null;
    if (rated.length > 0) {
      var sum = rated.reduce(function (acc, p) {
        return acc + p.myRating;
      }, 0);
      averageRating = Math.round((sum / rated.length) * 100) / 100;
    }
    var modelCounts = {};
    prompts.forEach(function (p) {
      var model =
        p.metadata && p.metadata.model ? p.metadata.model.trim() : "Unknown";
      modelCounts[model] = (modelCounts[model] || 0) + 1;
    });
    var mostUsedModel = null;
    var top = 0;
    Object.keys(modelCounts).forEach(function (name) {
      if (modelCounts[name] > top) {
        top = modelCounts[name];
        mostUsedModel = name;
      }
    });
    return {
      totalPrompts: totalPrompts,
      averageRating: averageRating,
      mostUsedModel: mostUsedModel,
    };
  }

  function collectNotesForExport(prompts) {
    var store = loadNotesStore();
    var notes = {};
    prompts.forEach(function (p) {
      var entry = store[p.id];
      if (
        entry &&
        typeof entry.body === "string" &&
        entry.body.trim()
      ) {
        notes[p.id] = {
          id: entry.id || "legacy_" + p.id,
          promptId: p.id,
          body: entry.body.trim(),
          updatedAt: entry.updatedAt || null,
        };
      }
    });
    return notes;
  }

  function validateAllPromptsIntegrity(prompts) {
    var errors = [];
    var seenIds = {};
    prompts.forEach(function (p, i) {
      var rowErrors = validatePromptIntegrity(p, i + 1);
      errors = errors.concat(rowErrors);
      if (p && typeof p.id === "string" && p.id.trim()) {
        if (seenIds[p.id]) {
          errors.push('Duplicate prompt id "' + p.id + '" in export data.');
        }
        seenIds[p.id] = true;
      }
    });
    return errors;
  }

  function buildExportDocument() {
    var prompts = loadPrompts();
    var serialized = [];
    var integrityErrors = [];

    prompts.forEach(function (p, i) {
      try {
        serialized.push(serializePromptForExport(p));
      } catch (e) {
        integrityErrors.push(
          "Prompt " +
            (i + 1) +
            " (" +
            (p.id || "no id") +
            "): " +
            (e && e.message ? e.message : "serialization failed."),
        );
      }
    });

    if (integrityErrors.length) {
      throw new Error(
        "Export aborted — data integrity check failed:\n" +
          integrityErrors.join("\n"),
      );
    }

    var postCheck = validateAllPromptsIntegrity(serialized);
    if (postCheck.length) {
      throw new Error(
        "Export aborted — validation failed:\n" + postCheck.join("\n"),
      );
    }

    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: nowIso8601(),
      statistics: computeExportStatistics(serialized),
      prompts: serialized,
      notes: collectNotesForExport(serialized),
    };
  }

  function exportFilenameTimestamp() {
    return nowIso8601().replace(/[:.]/g, "-");
  }

  function triggerJsonDownload(data, filename) {
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
  }

  function exportLibrary() {
    try {
      var doc = buildExportDocument();
      var filename =
        "prompt-library-export-" + exportFilenameTimestamp() + ".json";
      triggerJsonDownload(doc, filename);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message:
          e && e.message
            ? e.message
            : "Export failed due to an unknown error.",
      };
    }
  }

  function validateImportDocument(data) {
    var errors = [];
    if (!data || typeof data !== "object") {
      return ["Import file must contain a JSON object."];
    }
    if (
      typeof data.schemaVersion !== "number" ||
      SUPPORTED_IMPORT_VERSIONS.indexOf(data.schemaVersion) === -1
    ) {
      errors.push(
        "Unsupported or missing schemaVersion. Supported versions: " +
          SUPPORTED_IMPORT_VERSIONS.join(", ") +
          ".",
      );
    }
    if (data.exportedAt != null && !isValidIso8601(data.exportedAt)) {
      errors.push(
        'Optional "exportedAt" must be a valid ISO 8601 string (YYYY-MM-DDTHH:mm:ss.sssZ).',
      );
    }
    if (!Array.isArray(data.prompts)) {
      errors.push('"prompts" must be an array.');
      return errors;
    }
    if (data.prompts.length === 0) {
      errors.push("Import file contains no prompts.");
    }
    var seenIds = {};
    data.prompts.forEach(function (p, i) {
      var rowErrors = validatePromptIntegrity(p, i + 1);
      errors = errors.concat(rowErrors);
      if (p && typeof p.id === "string" && p.id.trim()) {
        if (seenIds[p.id]) {
          errors.push(
            'Duplicate prompt id "' + p.id + '" inside import file.',
          );
        }
        seenIds[p.id] = true;
      }
    });
    if (data.notes != null) {
      if (typeof data.notes !== "object" || Array.isArray(data.notes)) {
        errors.push('"notes" must be an object keyed by prompt id when present.');
      }
    }
    return errors;
  }

  function normalizeImportedPrompts(rawPrompts) {
    return rawPrompts.map(function (p) {
      return normalizePrompt(p);
    });
  }

  function findDuplicateIds(importedPrompts, existingPrompts) {
    var existingSet = {};
    existingPrompts.forEach(function (p) {
      if (p.id) existingSet[p.id] = true;
    });
    var duplicates = [];
    importedPrompts.forEach(function (p) {
      if (p.id && existingSet[p.id] && duplicates.indexOf(p.id) === -1) {
        duplicates.push(p.id);
      }
    });
    return duplicates;
  }

  function mergePromptLists(existing, imported, mode) {
    if (mode === "replace") {
      return imported.slice();
    }
    var byId = {};
    existing.forEach(function (p) {
      byId[p.id] = p;
    });
    imported.forEach(function (p) {
      if (mode === "merge-overwrite" || !byId[p.id]) {
        byId[p.id] = p;
      }
    });
    return Object.keys(byId).map(function (id) {
      return byId[id];
    });
  }

  function normalizeImportedNotes(rawNotes, validPromptIds) {
    if (!rawNotes || typeof rawNotes !== "object") return {};
    var out = {};
    Object.keys(rawNotes).forEach(function (key) {
      if (validPromptIds && validPromptIds.indexOf(key) === -1) return;
      var entry = rawNotes[key];
      if (!entry || typeof entry.body !== "string" || !entry.body.trim()) return;
      out[key] = {
        id:
          typeof entry.id === "string" && entry.id.trim()
            ? entry.id.trim()
            : "legacy_" + key,
        promptId: key,
        body: entry.body.trim(),
        updatedAt: entry.updatedAt || null,
      };
    });
    return out;
  }

  function notesStoreFromObject(notesObj) {
    var store = {};
    Object.keys(notesObj).forEach(function (promptId) {
      var n = notesObj[promptId];
      store[promptId] = {
        id: n.id,
        promptId: promptId,
        body: n.body,
        updatedAt: n.updatedAt,
      };
    });
    return store;
  }

  function mergeNotesStores(existingStore, importedNotesObj, mode, importedIds) {
    if (mode === "replace") {
      return notesStoreFromObject(importedNotesObj);
    }
    var merged = {};
    Object.keys(existingStore).forEach(function (k) {
      merged[k] = existingStore[k];
    });
    Object.keys(importedNotesObj).forEach(function (promptId) {
      if (importedIds.indexOf(promptId) === -1) return;
      if (mode === "merge-overwrite" || !merged[promptId]) {
        var n = importedNotesObj[promptId];
        merged[promptId] = {
          id: n.id,
          promptId: promptId,
          body: n.body,
          updatedAt: n.updatedAt,
        };
      }
    });
    return merged;
  }

  function createImportBackup() {
    return {
      prompts: localStorage.getItem(STORAGE_KEY),
      notes: localStorage.getItem(NOTES_STORAGE_KEY),
      savedAt: nowIso8601(),
    };
  }

  function persistImportBackup(backup) {
    try {
      sessionStorage.setItem(BACKUP_SESSION_KEY, JSON.stringify(backup));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message:
          "Could not create a safety backup before import. Import cancelled.",
      };
    }
  }

  function restoreImportBackup(backup) {
    try {
      if (backup.prompts == null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, backup.prompts);
      }
      if (backup.notes == null) {
        localStorage.removeItem(NOTES_STORAGE_KEY);
      } else {
        localStorage.setItem(NOTES_STORAGE_KEY, backup.notes);
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message:
          "Rollback failed. Your previous data may still be in session backup key: " +
          BACKUP_SESSION_KEY,
      };
    }
  }

  function clearImportBackup() {
    try {
      sessionStorage.removeItem(BACKUP_SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function applyImport(payload, mode) {
    var imported = normalizeImportedPrompts(payload.prompts);
    var existing = loadPrompts();
    var mergedPrompts = mergePromptLists(existing, imported, mode);
    var importedIds = imported.map(function (p) {
      return p.id;
    });
    var importedNotes = normalizeImportedNotes(
      payload.notes || {},
      importedIds,
    );
    var existingNotes = loadNotesStore();
    var mergedNotes = mergeNotesStores(
      existingNotes,
      importedNotes,
      mode,
      importedIds,
    );

    var saveP = savePrompts(mergedPrompts);
    if (!saveP.ok) {
      return { ok: false, message: saveP.message, stage: "prompts" };
    }
    var saveN = saveNotesStore(mergedNotes);
    if (!saveN.ok) {
      return {
        ok: false,
        message:
          saveN.reason === "quota"
            ? "Storage quota exceeded while saving notes."
            : "Could not save notes after importing prompts.",
        stage: "notes",
      };
    }
    return {
      ok: true,
      importedCount: imported.length,
      totalCount: mergedPrompts.length,
    };
  }

  function runImportWithRollback(payload, mode) {
    var backup = createImportBackup();
    var backupSave = persistImportBackup(backup);
    if (!backupSave.ok) {
      return { ok: false, message: backupSave.message };
    }

    var result = applyImport(payload, mode);
    if (!result.ok) {
      var restored = restoreImportBackup(backup);
      var rollbackNote = restored.ok
        ? " Your previous library was restored."
        : " Rollback failed — check session backup.";
      return {
        ok: false,
        message: (result.message || "Import failed.") + rollbackNote,
        stage: result.stage,
      };
    }

    clearImportBackup();
    return result;
  }

  function readImportFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error("No file selected."));
        return;
      }
      if (!/\.json$/i.test(file.name) && file.type && file.type !== "application/json") {
        reject(
          new Error(
            'File "' +
              file.name +
              '" does not appear to be JSON. Choose a .json export file.',
          ),
        );
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result || ""));
          resolve(data);
        } catch (e) {
          reject(
            new Error(
              "Invalid JSON in import file: " +
                (e && e.message ? e.message : "parse error"),
            ),
          );
        }
      };
      reader.onerror = function () {
        reject(new Error("Could not read the selected file."));
      };
      reader.readAsText(file);
    });
  }

  function setImportModalError(message) {
    if (!importModalError) return;
    if (message) {
      importModalError.textContent = message;
      importModalError.hidden = false;
    } else {
      importModalError.textContent = "";
      importModalError.hidden = true;
    }
  }

  function openImportModal(payload, duplicateIds) {
    if (!importModal) return;
    pendingImport = payload;
    var count = payload.prompts.length;
    var stats = payload.statistics;
    var statsLine = stats
      ? " File stats: " +
        stats.totalPrompts +
        " prompt(s)" +
        (stats.mostUsedModel
          ? ', most used model "' + stats.mostUsedModel + '"'
          : "") +
        (stats.averageRating != null
          ? ", average rating " + stats.averageRating
          : "") +
        "."
      : "";
    if (importModalSummary) {
      importModalSummary.textContent =
        "Found " +
        count +
        " prompt(s) to import (schema v" +
        payload.schemaVersion +
        ", exported " +
        (payload.exportedAt
          ? formatHumanDate(payload.exportedAt)
          : "unknown date") +
        ")." +
        statsLine;
    }
    if (importModalDuplicates) {
      if (duplicateIds.length > 0) {
        importModalDuplicates.hidden = false;
        importModalDuplicates.textContent =
          duplicateIds.length +
          " duplicate ID(s) conflict with your library: " +
          duplicateIds.slice(0, 5).join(", ") +
          (duplicateIds.length > 5
            ? " … (+" + (duplicateIds.length - 5) + " more)"
            : "") +
          ". Choose how to resolve below.";
      } else {
        importModalDuplicates.hidden = true;
        importModalDuplicates.textContent = "";
      }
    }
    setImportModalError("");
    importModal.hidden = false;
    if (importConfirmBtn) importConfirmBtn.focus();
  }

  function closeImportModal() {
    if (importModal) importModal.hidden = true;
    pendingImport = null;
    setImportModalError("");
    if (importFileInput) importFileInput.value = "";
  }

  function getSelectedImportMode() {
    var selected = document.querySelector('input[name="import-mode"]:checked');
    return selected ? selected.value : "merge-skip";
  }

  function handleImportFileSelected(file) {
    readImportFile(file)
      .then(function (data) {
        var errors = validateImportDocument(data);
        if (errors.length) {
          window.alert(
            "Import file validation failed:\n\n" + errors.join("\n"),
          );
          if (importFileInput) importFileInput.value = "";
          return;
        }
        var existing = loadPrompts();
        var imported = normalizeImportedPrompts(data.prompts);
        var duplicateIds = findDuplicateIds(imported, existing);
        openImportModal(data, duplicateIds);
      })
      .catch(function (err) {
        window.alert(
          err && err.message
            ? err.message
            : "Could not read the import file.",
        );
        if (importFileInput) importFileInput.value = "";
      });
  }

  function confirmImport() {
    if (!pendingImport) {
      setImportModalError("No import data loaded. Select a file again.");
      return;
    }
    var mode = getSelectedImportMode();
    if (
      mode === "replace" &&
      !window.confirm(
        "Replace all will permanently remove your current prompts and notes before importing. Continue?",
      )
    ) {
      return;
    }
    setImportModalError("");
    if (importConfirmBtn) importConfirmBtn.disabled = true;

    var result = runImportWithRollback(pendingImport, mode);

    if (importConfirmBtn) importConfirmBtn.disabled = false;

    if (!result.ok) {
      setImportModalError(result.message || "Import failed.");
      return;
    }

    closeImportModal();
    noteEditIds = {};
    render();
    window.alert(
      "Import complete. Added or updated " +
        result.importedCount +
        " prompt(s). Library now has " +
        result.totalCount +
        " prompt(s).",
    );
  }

  function normalizePrompt(p) {
    if (!p || typeof p !== "object")
      return { id: "", title: "", content: "", myRating: null };
    var r = p.myRating;
    if (
      r != null &&
      (typeof r !== "number" || r < 1 || r > 5 || r !== Math.floor(r))
    )
      r = null;
    var content = p.content || "";
    return {
      id: p.id || "",
      title: p.title || "",
      content: content,
      myRating: r == null ? null : r,
      ratedAt: p.ratedAt || null,
      metadata: normalizeMetadata(p.metadata, content, p.id),
    };
  }

  function makeId() {
    return (
      "p_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function makeNoteId() {
    return (
      "n_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function previewText(text, maxWords) {
    var trimmed = (text || "").replace(/\s+/g, " ").trim();
    if (!trimmed) return "—";
    var words = trimmed.split(" ");
    if (words.length <= maxWords) return trimmed;
    return words.slice(0, maxWords).join(" ") + "…";
  }

  function isPreviewTruncated(text, maxWords) {
    var trimmed = (text || "").replace(/\s+/g, " ").trim();
    if (!trimmed) return false;
    var words = trimmed.split(" ");
    return words.length > maxWords;
  }

  function sortPrompts(prompts, mode) {
    var copy = prompts.slice();
    if (mode === "newest") {
      copy.sort(function (a, b) {
        var ac = a.metadata && a.metadata.createdAt ? a.metadata.createdAt : "";
        var bc = b.metadata && b.metadata.createdAt ? b.metadata.createdAt : "";
        if (ac !== bc) return bc.localeCompare(ac);
        return 0;
      });
    } else if (mode === "rating-desc") {
      copy.sort(function (a, b) {
        var ar = a.myRating == null ? -1 : a.myRating;
        var br = b.myRating == null ? -1 : b.myRating;
        if (br !== ar) return br - ar;
        return 0;
      });
    } else if (mode === "unrated-first") {
      copy.sort(function (a, b) {
        var au = a.myRating == null ? 0 : 1;
        var bu = b.myRating == null ? 0 : 1;
        if (au !== bu) return au - bu;
        var ar = a.myRating == null ? -1 : a.myRating;
        var br = b.myRating == null ? -1 : b.myRating;
        return br - ar;
      });
    }
    return copy;
  }

  function fallbackCopyText(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyPromptContent(promptId, buttonEl) {
    var prompts = loadPrompts();
    var p = prompts.find(function (x) {
      return x.id === promptId;
    });
    if (!p) return;

    var text = p.content || "";
    var label = buttonEl.getAttribute("aria-label") || "Copy prompt content";
    var titleDefault = buttonEl.title || "Copy prompt content";

    function flashSuccess() {
      if (!buttonEl) return;
      buttonEl.classList.add("is-copied");
      buttonEl.setAttribute("aria-label", "Copied");
      buttonEl.title = "Copied";
      if (buttonEl._copyReset) clearTimeout(buttonEl._copyReset);
      buttonEl._copyReset = setTimeout(function () {
        buttonEl.classList.remove("is-copied");
        buttonEl.setAttribute("aria-label", label);
        buttonEl.title = titleDefault;
      }, 1600);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashSuccess).catch(function () {
        if (fallbackCopyText(text)) flashSuccess();
      });
    } else if (fallbackCopyText(text)) {
      flashSuccess();
    }
  }

  function createCopyIconSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "btn-icon__svg btn-icon__svg--copy");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "13");
    rect.setAttribute("height", "13");
    rect.setAttribute("rx", "2");
    svg.appendChild(rect);
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
    svg.appendChild(path);
    return svg;
  }

  function createCheckIconSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "btn-icon__svg btn-icon__svg--check");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(poly);
    return svg;
  }

  function loadNotesStore() {
    try {
      var raw = localStorage.getItem(NOTES_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch (e) {
      return {};
    }
  }

  function saveNotesStore(store) {
    try {
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(store));
      return { ok: true };
    } catch (e) {
      if (e && (e.name === "QuotaExceededError" || e.code === 22)) {
        return { ok: false, reason: "quota" };
      }
      return { ok: false, reason: "unknown" };
    }
  }

  function getNoteEntry(promptId) {
    var store = loadNotesStore();
    var entry = store[promptId];
    if (!entry || typeof entry.body !== "string" || !entry.body.trim()) return null;
    var noteId =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : "legacy_" + promptId;
    return {
      id: noteId,
      promptId: promptId,
      body: entry.body.trim(),
      updatedAt: entry.updatedAt || null,
    };
  }

  function saveNoteBody(promptId, body) {
    var trimmed = (body || "").trim();
    if (!trimmed) return { ok: false, reason: "empty" };
    var store = loadNotesStore();
    var existing = store[promptId];
    var noteId =
      existing && typeof existing.id === "string" && existing.id.trim()
        ? existing.id.trim()
        : makeNoteId();
    store[promptId] = {
      id: noteId,
      promptId: promptId,
      body: trimmed,
      updatedAt: Date.now(),
    };
    var result = saveNotesStore(store);
    if (!result.ok) return result;
    return { ok: true };
  }

  function deleteNoteBody(promptId) {
    var store = loadNotesStore();
    delete store[promptId];
    return saveNotesStore(store);
  }

  function flashNotesSaved(sectionEl) {
    if (!sectionEl) return;
    var msg = sectionEl.querySelector(".prompt-notes__status");
    if (!msg) return;
    msg.hidden = false;
    msg.textContent = "Saved";
    sectionEl.classList.add("is-saved");
    if (sectionEl._notesSavedTimer) clearTimeout(sectionEl._notesSavedTimer);
    sectionEl._notesSavedTimer = setTimeout(function () {
      sectionEl.classList.remove("is-saved");
      msg.hidden = true;
    }, 1600);
  }

  function showNotesError(sectionEl, text) {
    if (!sectionEl) return;
    var err = sectionEl.querySelector(".prompt-notes__error");
    if (!err) return;
    err.textContent = text;
    err.hidden = false;
    if (sectionEl._notesErrorTimer) clearTimeout(sectionEl._notesErrorTimer);
    sectionEl._notesErrorTimer = setTimeout(function () {
      err.hidden = true;
    }, 4000);
  }

  function setNotesMode(sectionEl, mode) {
    sectionEl.dataset.mode = mode;
    var empty = sectionEl.querySelector(".prompt-notes__empty");
    var view = sectionEl.querySelector(".prompt-notes__view");
    var edit = sectionEl.querySelector(".prompt-notes__edit");
    if (empty) empty.hidden = mode !== "empty";
    if (view) view.hidden = mode !== "view";
    if (edit) edit.hidden = mode !== "edit";
  }

  function refreshNotesSection(sectionEl, promptId) {
    var entry = getNoteEntry(promptId);
    sectionEl.dataset.noteId = entry ? entry.id : "";
    var bodyEl = sectionEl.querySelector(".prompt-notes__body");
    if (bodyEl) {
      bodyEl.dataset.noteId = entry ? entry.id : "";
      bodyEl.textContent = entry ? entry.body : "";
    }
    var mode = noteEditIds[promptId] ? "edit" : entry ? "view" : "empty";
    setNotesMode(sectionEl, mode);
    var textarea = sectionEl.querySelector(".prompt-notes__textarea");
    if (textarea && mode === "edit") {
      textarea.value = entry ? entry.body : "";
      textarea.focus();
    }
    var saveBtn = sectionEl.querySelector(".btn-notes-save");
    if (saveBtn) saveBtn.disabled = true;
  }

  function buildNotesSection(prompt) {
    var entry = getNoteEntry(prompt.id);
    var section = document.createElement("section");
    section.className = "prompt-notes";
    section.setAttribute("aria-labelledby", "notes-heading-" + prompt.id);
    section.dataset.promptId = prompt.id;
    section.dataset.noteId = entry ? entry.id : "";

    var heading = document.createElement("h4");
    heading.className = "prompt-notes__heading";
    heading.id = "notes-heading-" + prompt.id;
    heading.textContent = "Notes";

    var status = document.createElement("span");
    status.className = "prompt-notes__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;

    var err = document.createElement("p");
    err.className = "prompt-notes__error";
    err.setAttribute("role", "alert");
    err.hidden = true;

    var empty = document.createElement("div");
    empty.className = "prompt-notes__empty";
    var emptyText = document.createElement("p");
    emptyText.className = "prompt-notes__placeholder";
    emptyText.textContent = "No notes yet.";
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-notes btn-notes-add";
    addBtn.textContent = "Add note";
    addBtn.setAttribute(
      "aria-label",
      "Add note for " + (prompt.title || "Untitled"),
    );
    empty.appendChild(emptyText);
    empty.appendChild(addBtn);

    var view = document.createElement("div");
    view.className = "prompt-notes__view";
    var body = document.createElement("p");
    body.className = "prompt-notes__body";
    body.dataset.noteId = entry ? entry.id : "";
    body.textContent = entry ? entry.body : "";
    var viewActions = document.createElement("div");
    viewActions.className = "prompt-notes__actions";
    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-notes btn-notes-edit";
    editBtn.textContent = "Edit";
    editBtn.setAttribute(
      "aria-label",
      "Edit note for " + (prompt.title || "Untitled"),
    );
    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-notes btn-notes-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute(
      "aria-label",
      "Delete note for " + (prompt.title || "Untitled"),
    );
    viewActions.appendChild(editBtn);
    viewActions.appendChild(deleteBtn);
    view.appendChild(body);
    view.appendChild(viewActions);

    var edit = document.createElement("div");
    edit.className = "prompt-notes__edit";
    var textarea = document.createElement("textarea");
    textarea.className = "prompt-notes__textarea";
    textarea.rows = 3;
    textarea.placeholder = "Write a note for this prompt…";
    textarea.setAttribute(
      "aria-label",
      "Note for " + (prompt.title || "Untitled"),
    );
    if (entry) textarea.value = entry.body;
    var editActions = document.createElement("div");
    editActions.className = "prompt-notes__actions";
    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-notes btn-notes-save";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-notes btn-notes-cancel";
    cancelBtn.textContent = "Cancel";
    editActions.appendChild(saveBtn);
    editActions.appendChild(cancelBtn);
    edit.appendChild(textarea);
    edit.appendChild(editActions);

    section.appendChild(heading);
    section.appendChild(status);
    section.appendChild(err);
    section.appendChild(empty);
    section.appendChild(view);
    section.appendChild(edit);

    var mode = noteEditIds[prompt.id] ? "edit" : entry ? "view" : "empty";
    setNotesMode(section, mode);
    return section;
  }

  function deletePromptById(id) {
    delete noteEditIds[id];
    deleteNoteBody(id);
    var prompts = loadPrompts().filter(function (p) {
      return p.id !== id;
    });
    savePrompts(prompts);
    render();
  }

  function setRatingById(promptId, stars) {
    var prompts = loadPrompts();
    var idx = prompts.findIndex(function (p) {
      return p.id === promptId;
    });
    if (idx === -1) return;
    prompts[idx].myRating = stars;
    prompts[idx].ratedAt = stars == null ? null : new Date().toISOString();
    savePrompts(prompts);
    render();
  }

  function updateStarPreview(starRow, previewValue) {
    var buttons = starRow.querySelectorAll(".star-rating__btn");
    var saved =
      starRow.dataset.rating === ""
        ? null
        : parseInt(starRow.dataset.rating, 10);
    var hover = previewValue == null || previewValue < 1 ? null : previewValue;

    buttons.forEach(function (btn, i) {
      var n = i + 1;
      if (hover != null) {
        btn.classList.toggle("is-on", n <= hover);
      } else {
        btn.classList.toggle("is-on", saved != null && n <= saved);
      }
    });
  }

  function syncStarRowAria(starRow) {
    var val =
      starRow.dataset.rating === "" ? 0 : parseInt(starRow.dataset.rating, 10);
    var has = val >= 1 && val <= 5;
    starRow.setAttribute("aria-valuenow", has ? String(val) : "0");
    starRow.setAttribute(
      "aria-valuetext",
      has
        ? val + " star" + (val === 1 ? "" : "s") + " — effectiveness"
        : "Not rated",
    );
  }

  function buildMetadataSection(prompt) {
    var section = document.createElement("div");
    section.className = "prompt-metadata";
    section.setAttribute("aria-label", "Prompt metadata");

    try {
      var meta = prompt.metadata;
      if (!meta) {
        throw new Error("No metadata attached to this prompt.");
      }

      var modelRow = document.createElement("p");
      modelRow.className = "prompt-metadata__row";
      var modelLabel = document.createElement("span");
      modelLabel.className = "prompt-metadata__label";
      modelLabel.textContent = "Model";
      var modelVal = document.createElement("span");
      modelVal.className = "prompt-metadata__value prompt-metadata__model";
      modelVal.textContent = meta.model;
      modelRow.appendChild(modelLabel);
      modelRow.appendChild(modelVal);

      var timeRow = document.createElement("p");
      timeRow.className =
        "prompt-metadata__row prompt-metadata__timestamps";
      var timeLabel = document.createElement("span");
      timeLabel.className = "prompt-metadata__label";
      timeLabel.textContent = "Dates";
      var timeVal = document.createElement("span");
      timeVal.className = "prompt-metadata__value";
      timeVal.textContent =
        "Created " +
        formatHumanDate(meta.createdAt) +
        " · Updated " +
        formatHumanDate(meta.updatedAt);
      timeRow.appendChild(timeLabel);
      timeRow.appendChild(timeVal);

      var tokenRow = document.createElement("p");
      tokenRow.className = "prompt-metadata__row";
      var tokenLabel = document.createElement("span");
      tokenLabel.className = "prompt-metadata__label";
      tokenLabel.textContent = "Tokens";
      var tokenWrap = document.createElement("span");
      tokenWrap.className =
        "prompt-metadata__value prompt-metadata__tokens";
      var tokenText = document.createElement("span");
      tokenText.textContent = formatTokenRange(meta.tokenEstimate);
      var badge = document.createElement("span");
      var conf = meta.tokenEstimate
        ? meta.tokenEstimate.confidence
        : "medium";
      badge.className =
        "prompt-metadata__confidence prompt-metadata__confidence--" + conf;
      badge.textContent = conf + " confidence";
      badge.setAttribute("aria-label", conf + " confidence estimate");
      tokenWrap.appendChild(tokenText);
      tokenWrap.appendChild(badge);
      tokenRow.appendChild(tokenLabel);
      tokenRow.appendChild(tokenWrap);

      section.appendChild(modelRow);
      section.appendChild(timeRow);
      section.appendChild(tokenRow);
    } catch (err) {
      var errP = document.createElement("p");
      errP.className = "prompt-metadata__error";
      errP.textContent =
        err && err.message
          ? "Metadata unavailable: " + err.message
          : "Metadata unavailable.";
      section.appendChild(errP);
    }

    return section;
  }

  function buildStarRating(prompt) {
    var rating = prompt.myRating;
    var row = document.createElement("div");
    row.className = "star-rating";
    row.setAttribute("role", "slider");
    row.setAttribute("aria-valuemin", "0");
    row.setAttribute("aria-valuemax", "5");
    row.setAttribute("aria-valuenow", rating == null ? "0" : String(rating));
    row.setAttribute("tabindex", "0");
    row.setAttribute(
      "aria-label",
      "Rate effectiveness for " +
        (prompt.title || "Untitled").replace(/"/g, "'"),
    );
    row.dataset.id = prompt.id;
    row.dataset.rating = rating == null ? "" : String(rating);

    var hint = document.createElement("span");
    hint.className = "star-rating__hint";
    hint.textContent = "Rate";
    hint.setAttribute("aria-hidden", "true");

    var inner = document.createElement("div");
    inner.className = "star-rating__stars";
    inner.setAttribute("role", "presentation");

    for (var i = 1; i <= 5; i++) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "star-rating__btn";
      btn.dataset.value = String(i);
      btn.setAttribute("tabindex", "-1");
      btn.setAttribute(
        "aria-label",
        "Set rating to " + i + " star" + (i === 1 ? "" : "s"),
      );
      btn.textContent = "\u2605";
      if (rating != null && i <= rating) btn.classList.add("is-on");
      inner.appendChild(btn);
    }

    row.appendChild(hint);
    row.appendChild(inner);
    syncStarRowAria(row);
    updateStarPreview(row, null);
    return row;
  }

  function render() {
    var prompts = loadPrompts();
    listEl.innerHTML = "";

    if (prompts.length === 0) {
      emptyState.hidden = false;
      return;
    }

    emptyState.hidden = true;

    var mode = sortSelect ? sortSelect.value : "newest";
    var sorted = sortPrompts(prompts, mode);

    sorted.forEach(function (p) {
      var card = document.createElement("article");
      card.className = "prompt-card";
      card.setAttribute("role", "listitem");
      card.dataset.id = p.id;

      var header = document.createElement("div");
      header.className = "prompt-card__header";

      var title = document.createElement("h3");
      title.className = "prompt-card__title";
      title.textContent = p.title || "Untitled";

      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn-icon btn-copy prompt-card__copy";
      copyBtn.dataset.id = p.id;
      copyBtn.title = "Copy prompt content";
      copyBtn.setAttribute(
        "aria-label",
        "Copy prompt content: " + (p.title || "Untitled"),
      );
      copyBtn.appendChild(createCopyIconSvg());
      copyBtn.appendChild(createCheckIconSvg());

      header.appendChild(title);
      header.appendChild(copyBtn);

      var previewRow = document.createElement("div");
      previewRow.className = "prompt-card__preview-row";

      var preview = document.createElement("p");
      preview.className = "prompt-card__preview";
      preview.textContent = previewText(p.content, PREVIEW_WORD_COUNT);

      previewRow.appendChild(preview);

      if (isPreviewTruncated(p.content, PREVIEW_WORD_COUNT)) {
        var hintWrap = document.createElement("div");
        hintWrap.className = "prompt-card__hint-wrap";

        var hintBtn = document.createElement("button");
        hintBtn.type = "button";
        hintBtn.className = "btn-hint";
        hintBtn.textContent = "!";
        hintBtn.setAttribute(
          "aria-label",
          "Show full prompt text for " + (p.title || "Untitled"),
        );
        hintBtn.setAttribute("aria-describedby", "tooltip-" + p.id);

        var tip = document.createElement("div");
        tip.className = "prompt-card__tooltip";
        tip.id = "tooltip-" + p.id;
        tip.setAttribute("role", "tooltip");
        tip.textContent = (p.content || "").trim();

        hintWrap.appendChild(hintBtn);
        hintWrap.appendChild(tip);
        previewRow.appendChild(hintWrap);
      }

      var footer = document.createElement("div");
      footer.className = "prompt-card__footer";

      footer.appendChild(buildStarRating(p));

      var actions = document.createElement("div");
      actions.className = "prompt-card__actions";

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger";
      delBtn.textContent = "Delete";
      delBtn.setAttribute(
        "aria-label",
        "Delete prompt: " + (p.title || "Untitled"),
      );
      delBtn.dataset.id = p.id;

      actions.appendChild(delBtn);
      footer.appendChild(actions);
      card.appendChild(header);
      card.appendChild(buildMetadataSection(p));
      card.appendChild(previewRow);
      card.appendChild(buildNotesSection(p));
      card.appendChild(footer);
      listEl.appendChild(card);
    });
  }

  listEl.addEventListener("input", function (e) {
    var textarea = e.target.closest(".prompt-notes__textarea");
    if (!textarea || !listEl.contains(textarea)) return;
    var section = textarea.closest(".prompt-notes");
    if (!section) return;
    var promptId = section.dataset.promptId;
    var entry = getNoteEntry(promptId);
    var original = entry ? entry.body : "";
    var saveBtn = section.querySelector(".btn-notes-save");
    if (saveBtn) saveBtn.disabled = textarea.value.trim() === original;
  });

  listEl.addEventListener("click", function (e) {
    if (e.target.closest(".btn-hint")) return;

    var notesSection = e.target.closest(".prompt-notes");
    if (notesSection && listEl.contains(notesSection)) {
      var promptId = notesSection.dataset.promptId;
      var addBtn = e.target.closest(".btn-notes-add");
      if (addBtn) {
        noteEditIds[promptId] = true;
        refreshNotesSection(notesSection, promptId);
        return;
      }
      var editBtn = e.target.closest(".btn-notes-edit");
      if (editBtn) {
        noteEditIds[promptId] = true;
        refreshNotesSection(notesSection, promptId);
        return;
      }
      var cancelBtn = e.target.closest(".btn-notes-cancel");
      if (cancelBtn) {
        delete noteEditIds[promptId];
        refreshNotesSection(notesSection, promptId);
        return;
      }
      var saveBtn = e.target.closest(".btn-notes-save");
      if (saveBtn) {
        var textarea = notesSection.querySelector(".prompt-notes__textarea");
        var body = textarea ? textarea.value : "";
        var result = saveNoteBody(promptId, body);
        if (!result.ok) {
          if (result.reason === "empty") {
            showNotesError(
              notesSection,
              "Note cannot be empty. Use Delete to remove it.",
            );
          } else if (result.reason === "quota") {
            showNotesError(
              notesSection,
              "Storage full. Free space or remove other notes.",
            );
          } else {
            showNotesError(notesSection, "Could not save note.");
          }
          return;
        }
        delete noteEditIds[promptId];
        refreshNotesSection(notesSection, promptId);
        flashNotesSaved(notesSection);
        return;
      }
      var deleteBtn = e.target.closest(".btn-notes-delete");
      if (deleteBtn) {
        var card = notesSection.closest(".prompt-card");
        var titleEl = card ? card.querySelector(".prompt-card__title") : null;
        var title = titleEl ? titleEl.textContent : "this prompt";
        if (
          !window.confirm(
            "Delete the note for \"" + title + "\"? This cannot be undone.",
          )
        ) {
          return;
        }
        var delResult = deleteNoteBody(promptId);
        if (!delResult.ok) {
          showNotesError(
            notesSection,
            delResult.reason === "quota"
              ? "Storage full. Could not delete note."
              : "Could not delete note.",
          );
          return;
        }
        delete noteEditIds[promptId];
        refreshNotesSection(notesSection, promptId);
        return;
      }
    }

    var copyBtnClick = e.target.closest(".btn-copy");
    if (copyBtnClick && listEl.contains(copyBtnClick)) {
      copyPromptContent(copyBtnClick.dataset.id, copyBtnClick);
      return;
    }

    var del = e.target.closest(".btn-danger");
    if (del && listEl.contains(del)) {
      deletePromptById(del.dataset.id);
      return;
    }

    var starBtn = e.target.closest(".star-rating__btn");
    if (!starBtn || !listEl.contains(starBtn)) return;

    var row = starBtn.closest(".star-rating");
    if (!row || !listEl.contains(row)) return;

    var promptId = row.dataset.id;
    var value = parseInt(starBtn.dataset.value, 10);
    var current =
      row.dataset.rating === "" ? null : parseInt(row.dataset.rating, 10);
    var next = current === value ? null : value;
    setRatingById(promptId, next);
  });

  listEl.addEventListener("keydown", function (e) {
    var row = e.target.closest(".star-rating");
    if (!row || !listEl.contains(row) || e.target !== row) return;

    var current =
      row.dataset.rating === "" ? null : parseInt(row.dataset.rating, 10);
    var next = current;

    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      next = current == null ? 1 : Math.min(5, current + 1);
      setRatingById(row.dataset.id, next);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      if (current == null) next = null;
      else if (current <= 1) next = null;
      else next = current - 1;
      setRatingById(row.dataset.id, next);
    } else if (e.key === "Home") {
      e.preventDefault();
      setRatingById(row.dataset.id, 1);
    } else if (e.key === "End") {
      e.preventDefault();
      setRatingById(row.dataset.id, 5);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setRatingById(row.dataset.id, null);
    }
  });

  listEl.addEventListener(
    "pointerenter",
    function (e) {
      var btn = e.target.closest(".star-rating__btn");
      if (!btn || !listEl.contains(btn)) return;
      var row = btn.closest(".star-rating");
      if (!row) return;
      updateStarPreview(row, parseInt(btn.dataset.value, 10));
    },
    true,
  );

  listEl.addEventListener(
    "pointerleave",
    function (e) {
      var row = e.target.closest(".star-rating");
      if (!row || !listEl.contains(row)) return;
      if (!row.contains(e.relatedTarget)) updateStarPreview(row, null);
    },
    true,
  );

  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      render();
    });
  }

  if (btnExport) {
    btnExport.addEventListener("click", function () {
      var result = exportLibrary();
      if (!result.ok) {
        window.alert(result.message || "Export failed.");
      }
    });
  }

  if (btnImport && importFileInput) {
    btnImport.addEventListener("click", function () {
      importFileInput.click();
    });
    importFileInput.addEventListener("change", function () {
      var file = importFileInput.files && importFileInput.files[0];
      if (file) handleImportFileSelected(file);
    });
  }

  if (importCancelBtn) {
    importCancelBtn.addEventListener("click", closeImportModal);
  }

  if (importConfirmBtn) {
    importConfirmBtn.addEventListener("click", confirmImport);
  }

  if (importModal) {
    importModal.addEventListener("click", function (e) {
      if (e.target.closest("[data-import-dismiss]")) closeImportModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && importModal && !importModal.hidden) {
        closeImportModal();
      }
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var title = titleInput.value.trim();
    var content = contentInput.value.trim();
    var modelName = modelInput ? modelInput.value : "";

    if (!title || !content) return;

    var metadata;
    try {
      var isCode = isCodeInput
        ? isCodeInput.checked
        : detectCodeContent(content);
      metadata = trackModel(modelName, content);
      metadata.tokenEstimate = estimateTokens(content, isCode);
    } catch (err) {
      window.alert(
        err && err.message ? err.message : "Could not create prompt metadata.",
      );
      return;
    }

    var prompts = loadPrompts();
    prompts.unshift({
      id: makeId(),
      title: title,
      content: content,
      myRating: null,
      ratedAt: null,
      metadata: metadata,
    });
    savePrompts(prompts);

    form.reset();
    titleInput.focus();
    render();
  });

  render();
})();
