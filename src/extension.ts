import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

let extensionUriGlobal: vscode.Uri;
const decorationCache = new Map<string, vscode.TextEditorDecorationType>();
const completionItemMeta = new WeakMap<vscode.CompletionItem, { iconName: string; className: string }>();

// Cache for autocomplete icon list
let iconFilesCache: { name: string; uri: vscode.Uri }[] | null = null;

// Lazy hover preview cache (LRU) - keeps last ~300 hovered icons
const svgDataUrlCache = new Map<string, string>();
const SVG_CACHE_MAX = 300;

/**
 * LRU cache get operation - moves accessed item to end (most recent)
 */
function lruGet(cache: Map<string, string>, key: string): string | undefined {
  const v = cache.get(key);
  if (v === undefined) return undefined;
  // Refresh recency
  cache.delete(key);
  cache.set(key, v);
  return v;
}

/**
 * LRU cache set operation - evicts oldest item if cache is full
 */
function lruSet(cache: Map<string, string>, key: string, val: string) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  if (cache.size > SVG_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
}

/**
 * Retrieves SVG as base64 data URL with LRU caching
 * @param iconName - Name of the icon (without .svg extension)
 * @returns Base64-encoded data URL of the SVG
 */
function getSvgDataUrl(iconName: string): string {
  const cached = lruGet(svgDataUrlCache, iconName);
  if (cached) return cached;

  const imgUri = vscode.Uri.joinPath(
    extensionUriGlobal,
    "media",
    "icons",
    `${iconName}.svg`
  );

  const svgBuf = fs.readFileSync(imgUri.fsPath);
  const b64 = Buffer.from(svgBuf).toString("base64");
  const dataUrl = `data:image/svg+xml;base64,${b64}`;

  lruSet(svgDataUrlCache, iconName, dataUrl);
  return dataUrl;
}

export function activate(context: vscode.ExtensionContext) {
  extensionUriGlobal = context.extensionUri;

  // Initialize decorations for the currently active editor
  const active = vscode.window.activeTextEditor;
  if (active) {
    updateDecorations(active);
  }


  // AUTOCOMPLETE: Provides suggestions and small previews when typing "ti ti-..." in class attributes
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    ["html", "svelte", "javascriptreact", "typescriptreact"],
    {
      provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text;

        // Skip if line doesn't contain "ti "
        if (!lineText.includes("ti ")) return;

        const wordRange = document.getWordRangeAtPosition(position, /ti[-\w]*/);
        if (!wordRange) return;

        const icons = loadIconFiles();

        // Lazy loading: No SVG reading here, just the item list
        return icons.map((icon) => {
          const className = `ti-${icon.name}`;

          const item = new vscode.CompletionItem(
            className,
            vscode.CompletionItemKind.Value
          );

          item.insertText = className;
          item.detail = icon.name;

          // Lazy: documentation will be filled in resolveCompletionItem
          item.documentation = new vscode.MarkdownString("Hover to preview icon…");

          // Store icon name for resolve step (WeakMap because CompletionItem has no .data in VSCode typings)
          completionItemMeta.set(item, { iconName: icon.name, className });

          return item;
        });
      },

      resolveCompletionItem(item: vscode.CompletionItem) {
        const data = completionItemMeta.get(item);
        if (!data?.iconName || !data?.className) return item;

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        try {
          const dataUrl = getSvgDataUrl(data.iconName);
          md.appendMarkdown(
            `<img src="${dataUrl}" width="16" height="16" /> ` +
              `<img src="${dataUrl}" width="24" height="24" /> ` +
              `<img src="${dataUrl}" width="32" height="32" /> ` +
              `<img src="${dataUrl}" width="48" height="48" /> ` +
              `<img src="${dataUrl}" width="64" height="64" /> ` +
              `<img src="${dataUrl}" width="96" height="96" />\n\n`
          );
        } catch {
          md.appendMarkdown(`(Failed to read icon: ${data.iconName})\n\n`);
        }

        md.appendCodeblock(`<i class=\"${data.className}\"></i>`, "html");
        item.documentation = md;
        return item;
      },
    },
    "-", // Trigger on typing "ti-"
    " "  // Also trigger after space
  );

  context.subscriptions.push(completionProvider);


  // Update decorations when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDecorations(editor);
    })
  );

  // Update decorations when document content changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        updateDecorations(editor);
      }
    })
  );
}

export function deactivate() {
  // Clean up all decorations
  for (const deco of decorationCache.values()) {
    deco.dispose();
  }
  decorationCache.clear();
}

/**
 * Retrieves or creates a decoration type for a specific icon
 * @param name - Icon name (e.g., "x", "search")
 * @returns TextEditorDecorationType with icon gutter and inline preview
 */
function getDecorationForIcon(name: string): vscode.TextEditorDecorationType {
  const cached = decorationCache.get(name);
  if (cached) return cached;

  const iconUri = vscode.Uri.joinPath(
    extensionUriGlobal,
    "media",
    "icons",
    `${name}.svg`
  );

  const deco = vscode.window.createTextEditorDecorationType({
    gutterIconPath: iconUri,
    gutterIconSize: "18px",
    before: {
      contentIconPath: iconUri,
      margin: "0px 6px 0px 3px", // Spacing between icon and text
      // Slightly lower the icon position (in pixels)
      textDecoration: "none; position: relative; top: 1px;",
    },
  });

  decorationCache.set(name, deco);
  return deco;
}

/**
 * Updates inline and gutter icon decorations for the current editor
 * Searches for "ti ti-{iconName}" patterns and displays corresponding icons
 */
function updateDecorations(editor: vscode.TextEditor) {
  const doc = editor.document;

  // Only apply decorations to HTML, Svelte, JSX/TSX files
  const lang = doc.languageId;
  const allowed = ["html", "svelte", "javascriptreact", "typescriptreact"];
  if (!allowed.includes(lang)) {
    // Clear decorations for other languages
    for (const deco of decorationCache.values()) {
      editor.setDecorations(deco, []);
    }
    return;
  }

  // Clear all previous decorations
  for (const deco of decorationCache.values()) {
    editor.setDecorations(deco, []);
  }

  // Map: iconName -> array of ranges where that icon appears
  const rangesByIcon = new Map<string, vscode.DecorationOptions[]>();

  // Find all "ti ti-ICONNAME" patterns in class attributes
  const regex = /ti ti-([a-z0-9-]+)/g;

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text))) {
      const iconName = match[1]; // e.g., "x", "search", "brand-facebook"
      const start = new vscode.Position(line, match.index);
      const end = new vscode.Position(line, match.index + match[0].length);
      const range = new vscode.Range(start, end);

      if (!rangesByIcon.has(iconName)) {
        rangesByIcon.set(iconName, []);
      }
      rangesByIcon.get(iconName)!.push({ range });
    }
  }

  // Apply decorations for each icon type
  for (const [iconName, ranges] of rangesByIcon.entries()) {
    const deco = getDecorationForIcon(iconName);
    editor.setDecorations(deco, ranges);
  }
}

/**
 * Loads the list of available icon files from the media/icons directory
 * Results are cached after first load
 * @returns Array of icon objects with name and URI
 */
function loadIconFiles(): { name: string; uri: vscode.Uri }[] {
  if (iconFilesCache) return iconFilesCache;

  const iconsDirUri = vscode.Uri.joinPath(extensionUriGlobal, "media", "icons");
  const iconsDirPath = iconsDirUri.fsPath;

  const files = fs
    .readdirSync(iconsDirPath)
    .filter((f) => f.endsWith(".svg"))
    .map((file) => {
      const name = path.basename(file, ".svg"); // x.svg -> x
      const uri = vscode.Uri.joinPath(iconsDirUri, file);
      return { name, uri };
    });

  iconFilesCache = files;
  return files;
}
