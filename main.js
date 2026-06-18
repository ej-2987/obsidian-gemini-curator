const { Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, Notice, requestUrl } = require("obsidian");

const VIEW_TYPE_GEMINI_CURATOR = "gemini-curator-view";

const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  atlasFolder: "Atlas",
  curationFolder: "Curations"
};

// --- Main Plugin Class ---
class GeminiCuratorPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Auto-migrate Gemini key on load if not set
    if (!this.settings.geminiApiKey) {
      await this.migrateGeminiKey();
    }

    // Register sidebar view
    this.registerView(
      VIEW_TYPE_GEMINI_CURATOR,
      (leaf) => new GeminiCuratorView(leaf, this)
    );

    // Ribbon button to open sidebar
    this.addRibbonIcon("sparkles", "Gemini Curator", () => {
      this.activateView();
    });

    // Command palette command
    this.addCommand({
      id: "open-gemini-curator",
      name: "Open Gemini Curator Sidebar",
      callback: () => this.activateView(),
    });

    // Register settings tab
    this.addSettingTab(new GeminiCuratorSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async migrateGeminiKey() {
    try {
      const scConfigPath = ".obsidian/plugins/smart-composer/data.json";
      if (await this.app.vault.adapter.exists(scConfigPath)) {
        const scConfigStr = await this.app.vault.adapter.read(scConfigPath);
        const scConfig = JSON.parse(scConfigStr);
        const geminiProvider = scConfig.providers?.find(p => p.type === "gemini");
        if (geminiProvider && geminiProvider.apiKey) {
          this.settings.geminiApiKey = geminiProvider.apiKey;
          await this.saveSettings();
          new Notice("Smart Composer에서 Gemini API Key를 자동으로 가져왔습니다!");
        }
      }
    } catch (e) {
      console.log("Failed to auto-migrate Gemini Key:", e.message);
    }
  }

  async activateView() {
    let leaf = null;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CURATOR);
    
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_GEMINI_CURATOR,
        active: true,
      });
    }
    
    this.app.workspace.revealLeaf(leaf);
  }

  parseJSON(text, fallbackTitle) {
    let cleanText = text.trim();
    if (cleanText.startsWith("```")) {
      const fenced = cleanText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      cleanText = fenced ? fenced[1].trim() : cleanText;
    }
    const startIdx = cleanText.indexOf('{');
    const endIdx = cleanText.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1) {
      throw new Error("JSON 형식을 찾을 수 없습니다.");
    }
    const jsonStr = cleanText.substring(startIdx, endIdx + 1);
    let result = JSON.parse(jsonStr);
    if (!Array.isArray(result.articles) || result.articles.length === 0) {
      throw new Error("관련 기사를 찾지 못했습니다.");
    }
    result.selected_note = result.selected_note || fallbackTitle;
    result.connection = result.connection || "";
    return result;
  }

  async saveCuration(article, sourceNoteTitle, connection) {
    try {
      const curationFolder = this.settings.curationFolder.trim() || "Curations";
      
      // Ensure folder exists
      if (!(await this.app.vault.adapter.exists(curationFolder))) {
        await this.app.vault.createFolder(curationFolder);
      }
      
      // Sanitize title for filename
      const sanitizedTitle = article.title.replace(/[\\/:*?"<>|]/g, "_").trim();
      const filename = `${curationFolder}/${sanitizedTitle}.md`;
      
      // Avoid overwriting
      if (await this.app.vault.adapter.exists(filename)) {
        new Notice("이미 저장된 큐레이션 파일이 존재합니다!");
        return false;
      }
      
      const today = new Date().toISOString().split('T')[0];
      
      const fileContent = `---
type: curation
source_note: "[[${sourceNoteTitle}]]"
curated_at: ${today}
source_url: "${article.url}"
original_title: "${article.title.replace(/"/g, '\\"')}"
author: "${(article.author || "").replace(/"/g, '\\"')}"
---

# 🔎 Curation: ${article.title}

## 🔗 Curation Metadata
* **Original Note:** [[${sourceNoteTitle}]]
* **Original Source:** [View Original Article](${article.url})
* **Author:** ${article.author || "Unknown"}
* **Published Date:** ${article.date || today}

---

## 💡 Curation Connection (Korean)
${connection}

---

## 📝 Summary (Korean)
${article.summary}

---

## 📄 Original Text (English)
\`\`\`text
${article.original_text || "Original text not provided."}
\`\`\`
`;
      
      await this.app.vault.create(filename, fileContent);
      new Notice(`큐레이션 저장 성공: ${sanitizedTitle}`);
      return true;
    } catch (e) {
      new Notice(`큐레이션 저장 실패: ${e.message}`);
      console.error(e);
      return false;
    }
  }
}

// --- Custom Sidebar View (ItemView) ---
class GeminiCuratorView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_GEMINI_CURATOR;
  }

  getDisplayText() {
    return "Gemini Curator";
  }

  getIcon() {
    return "sparkles";
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("gemini-curator-view");

    // Header
    const header = container.createEl("div", { cls: "gemini-curator-header" });
    const logoContainer = header.createEl("div", { cls: "gemini-curator-logo-container" });
    logoContainer.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2L14.73 8.27L21 9.24L16.5 13.97L17.58 21L12 17.27L6.42 21L7.5 13.97L3 9.24L9.27 8.27L12 2Z"/></svg>`;
    header.createEl("h1", { text: "Gemini Curator", cls: "gemini-curator-title" });
    header.createEl("p", { text: "Random note expansion hub", cls: "gemini-curator-subtitle" });

    // Pick & Curate Button
    const curateBtn = container.createEl("button", { cls: "gemini-curator-btn", text: "Pick Note & Curate" });
    curateBtn.addEventListener("click", () => this.runCuratorWorkflow());

    // Selected Note Panel
    this.selectedNotePanel = container.createEl("div", { cls: "gemini-curator-selected-note-section" });
    this.renderEmptySelectedNote();

    // Loading Container
    this.loadingContainer = container.createEl("div", { cls: "gemini-curator-loading-container" });
    this.loadingContainer.style.display = "none";
    this.renderLoadingShimmer();

    // Results Container
    this.resultsContainer = container.createEl("div");
  }

  renderEmptySelectedNote() {
    this.selectedNotePanel.empty();
    this.selectedNotePanel.createEl("div", { text: "Selected Note", cls: "gemini-curator-section-title" });
    this.selectedNotePanel.createEl("p", { text: "No note selected yet. Click the button above to begin.", cls: "gemini-curator-selected-note-preview" });
  }

  renderLoadingShimmer() {
    this.loadingContainer.empty();
    this.loadingContainer.createEl("p", { text: "Reading note & searching web...", style: "text-align:center; font-size:0.85rem; font-style:italic;" });
    this.loadingContainer.createEl("div", { cls: "gemini-curator-shimmer gemini-curator-shimmer-note" });
    this.loadingContainer.createEl("div", { cls: "gemini-curator-shimmer gemini-curator-shimmer-card" });
  }

  async runCuratorWorkflow() {
    if (!this.plugin.settings.geminiApiKey) {
      new Notice("설정에서 Gemini API Key를 먼저 설정해 주세요!");
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const atlasFolder = this.plugin.settings.atlasFolder.trim() || "Atlas";
    
    // Normalize path matches
    const atlasFiles = files.filter(f => f.path.startsWith(atlasFolder + "/"));

    if (atlasFiles.length === 0) {
      new Notice(`'${atlasFolder}' 폴더 내에 마크다운 메모 파일이 존재하지 않습니다.`);
      return;
    }

    const randomFile = atlasFiles[Math.floor(Math.random() * atlasFiles.length)];
    const noteContent = await this.app.vault.read(randomFile);

    // Update UI selected note display
    this.selectedNotePanel.empty();
    this.selectedNotePanel.createEl("div", { text: "Selected Note", cls: "gemini-curator-section-title" });
    this.selectedNotePanel.createEl("h3", { text: randomFile.basename, cls: "gemini-curator-selected-note-title" });
    this.selectedNotePanel.createEl("p", { text: noteContent.trim() || "(Empty note content)", cls: "gemini-curator-selected-note-preview" });

    // Show Loading, Clear results
    this.resultsContainer.empty();
    this.loadingContainer.style.display = "flex";

    try {
      const systemMsg = `You are a professional researcher. Your task is to expand the user's obsidian note by finding the most recent, high-quality, long-form content (articles, columns, essays, academic papers, etc.) published in the last 3 months.
You MUST use your web search tool to find actual real-time articles related to the note topic.
CRITICAL: Do NOT quote copyrighted web sources verbatim. Verbatim quotes will trigger RECITATION/COPYRIGHT blocks and fail the request. Instead, synthesize, explain, and PARAPHRASE the key original concepts in your own words.
You must return your findings in the following JSON schema:
{
  "articles": [
    {
      "title": "Title of the article",
      "author": "Author or publisher name",
      "date": "YYYY-MM-DD (approximate publication date, must be within the last 3 months)",
      "url": "Direct HTTP URL to the original source",
      "summary": "Detailed Korean summary of the key insights of the article (3-4 bullet points). If the original article is in English, translate and summarize in Korean.",
      "original_text": "A detailed, paraphrased overview of the key sections of the article in its original language (e.g., English). Do NOT use verbatim copy-paste quotes. Paraphrase and summarize the core research or reporting in your own words."
    }
  ],
  "connection": "Detailed Korean explanation (3-4 sentences) describing how these curated articles connect to the original note and how they help expand the user's knowledge."
}
Only output the JSON object. Do not include any introductory or concluding conversational text outside of the JSON. If you return markdown code blocks, wrap the JSON in \`\`\`json ... \`\`\`.`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(this.plugin.settings.geminiApiKey)}`;
      
      const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemMsg }] },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Selected Note Title: ${randomFile.basename}\n\nNote Content:\n${noteContent}`
                }
              ]
            }
          ],
          tools: [{ googleSearch: {} }],
          safetySettings: [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
          ],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.2
          }
        }),
        throw: false
      });

      if (response.status !== 200) {
        const errText = response.json?.error?.message || `HTTP ${response.status}`;
        throw new Error(errText);
      }

      const candidate = response.json?.candidates?.[0];
      const finishReason = candidate?.finishReason;
      const text = candidate?.content?.parts?.[0]?.text ?? "";
      if (!text.trim()) {
        if (finishReason && finishReason !== "STOP") {
          throw new Error(`API가 콘텐츠를 차단했습니다 (원인: ${finishReason}). 안전 필터 혹은 저작권 차단이 원인일 수 있습니다.`);
        }
        throw new Error("API가 빈 응답을 반환했습니다. 다시 시도해 주세요.");
      }

      const result = this.plugin.parseJSON(text, randomFile.basename);

      // Render Curation Result Cards
      this.renderResults(result, randomFile.basename);
    } catch (err) {
      new Notice(`큐레이션 실패: ${err.message}`);
      console.error(err);
      this.resultsContainer.empty();
      this.resultsContainer.createEl("p", { text: `에러 발생: ${err.message}`, style: "color: var(--text-error); text-align:center; font-size: 0.85rem;" });
    } finally {
      this.loadingContainer.style.display = "none";
    }
  }

  renderResults(result, sourceNoteTitle) {
    this.resultsContainer.empty();

    this.resultsContainer.createEl("h2", { text: "Curations Found", cls: "gemini-curator-results-header" });

    // Render Connection Curation Header
    if (result.connection) {
      this.resultsContainer.createEl("div", { text: result.connection, cls: "gemini-curator-connection-card" });
    }

    const listContainer = this.resultsContainer.createEl("div", { cls: "gemini-curator-articles-list" });

    result.articles.forEach(article => {
      const card = listContainer.createEl("div", { cls: "gemini-curator-article-card" });

      // Meta Author + Date
      const meta = card.createEl("div", { cls: "gemini-curator-article-meta" });
      meta.createEl("span", { text: `By ${article.author || "Unknown"}` });
      meta.createEl("span", { text: "•" });
      meta.createEl("span", { text: article.date || "Recent" });

      // Title
      card.createEl("h4", { text: article.title, cls: "gemini-curator-article-title" });

      // Summary (Korean)
      card.createEl("p", { text: article.summary, cls: "gemini-curator-article-summary" });

      // Collapsible Original Text (English)
      if (article.original_text) {
        const collapseContainer = card.createEl("div", { cls: "gemini-curator-collapsible-container" });
        const header = collapseContainer.createEl("div", { cls: "gemini-curator-collapsible-header" });
        header.createEl("span", { text: "View Original Text" });
        const arrow = header.createEl("span", { text: "▼", style: "font-size:0.6rem; transition: transform 0.2s;" });
        
        const textBlock = collapseContainer.createEl("div", { text: article.original_text, cls: "gemini-curator-collapsible-content" });
        textBlock.style.display = "none";

        header.addEventListener("click", () => {
          if (textBlock.style.display === "none") {
            textBlock.style.display = "block";
            arrow.style.transform = "rotate(180deg)";
          } else {
            textBlock.style.display = "none";
            arrow.style.transform = "rotate(0deg)";
          }
        });
      }

      // Actions View & Save
      const actions = card.createEl("div", { cls: "gemini-curator-actions" });
      
      const viewBtn = actions.createEl("a", { cls: "gemini-curator-card-btn", text: "View Source" });
      viewBtn.href = article.url;
      viewBtn.target = "_blank";

      const saveBtn = actions.createEl("button", { cls: "gemini-curator-card-btn gemini-curator-card-btn-primary", text: "Save Curation" });
      saveBtn.addEventListener("click", async () => {
        const success = await this.plugin.saveCuration(article, sourceNoteTitle, result.connection);
        if (success) {
          saveBtn.text = "Saved ✓";
          saveBtn.disabled = true;
          saveBtn.removeClass("gemini-curator-card-btn-primary");
          saveBtn.addClass("gemini-curator-card-btn-saved");
        }
      });
    });
  }

  async onClose() {
    // Clean up when view closed
  }
}

// --- Settings Tab ---
class GeminiCuratorSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Gemini Curator Settings" });

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("Get your key from Google AI Studio (https://aistudio.google.com)")
      .addText(text => text
        .setPlaceholder("AIzaSy...")
        .setValue(this.plugin.settings.geminiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Atlas Folder Path")
      .setDesc("The folder where markdown files are randomly picked from (recursive).")
      .addText(text => text
        .setPlaceholder("Atlas")
        .setValue(this.plugin.settings.atlasFolder)
        .onChange(async (value) => {
          this.plugin.settings.atlasFolder = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Curation Folder Path")
      .setDesc("The folder where new curation notes will be saved.")
      .addText(text => text
        .setPlaceholder("Curations")
        .setValue(this.plugin.settings.curationFolder)
        .onChange(async (value) => {
          this.plugin.settings.curationFolder = value.trim();
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = GeminiCuratorPlugin;
