class ModuleRegistry {
  constructor() {
    this.modules = new Map();
    this.tools = new Map(); // toolName -> schema
    this.toolHandlers = new Map(); // toolName -> fn
    this.tasks = new Map(); // taskName -> fn
    this.taskFormatters = new Map(); // taskName -> fn
    this.intentMatchers = []; // Array of fns
    this.promptPacks = new Map(); // domain -> fn
    this.planBuilders = []; // Array of fns
    this.evidenceExtractors = []; // Array of fns
  }

  /**
   * Register a capability module
   * @param {object} mod
   */
  register(mod) {
    if (this.modules.has(mod.id)) return;
    this.modules.set(mod.id, mod);

    if (mod.tools) {
      for (const tool of mod.tools) {
        this.tools.set(tool.function.name, tool);
      }
    }

    if (mod.toolHandlers) {
      for (const [name, handler] of Object.entries(mod.toolHandlers)) {
        this.toolHandlers.set(name, handler);
      }
    }

    if (mod.tasks) {
      for (const [name, def] of Object.entries(mod.tasks)) {
        this.tasks.set(name, def.execute);
        if (def.format) this.taskFormatters.set(name, def.format);
      }
    }

    if (mod.intent) {
      this.intentMatchers.push(mod.intent);
    }

    if (mod.promptPack) {
      this.promptPacks.set(mod.id, mod.promptPack);
    }

    if (mod.buildPlan) {
      this.planBuilders.push(mod.buildPlan);
    }

    if (mod.evidenceExtractor) {
      this.evidenceExtractors.push(mod.evidenceExtractor);
    }
  }

  getTools() {
    return Array.from(this.tools.values());
  }

  getToolSchema(name) {
    return this.tools.get(name);
  }

  getToolHandler(name) {
    return this.toolHandlers.get(name);
  }

  getTask(name) {
    return this.tasks.get(name);
  }

  getTaskFormatter(name) {
    return this.taskFormatters.get(name);
  }

  getTasks() {
    return Array.from(this.tasks.keys());
  }

  matchIntent(text, ctx) {
    const matches = [];
    for (const matcher of this.intentMatchers) {
      const result = matcher(text, ctx);
      if (result) matches.push(result);
    }
    if (!matches.length) return null;

    // Deferred schedule language always wins over jira/web/etc.
    const sched = matches.find((m) => m.domain === 'scheduler');
    if (sched) return sched;

    return matches[0];
  }

  getPromptPack(domain, intent, opts) {
    const pack = this.promptPacks.get(domain);
    return pack ? pack(intent, opts) : null;
  }

  buildPlanSteps(intent, userText, opts, pushTool, pushGuidance) {
    for (const builder of this.planBuilders) {
      builder(intent, userText, opts, pushTool, pushGuidance);
    }
  }

  extractEvidence(tool, envelope, text, out) {
    for (const extractor of this.evidenceExtractors) {
      extractor(tool, envelope, text, out);
    }
  }
}

const registry = new ModuleRegistry();
module.exports = registry;
