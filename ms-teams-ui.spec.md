Here is a Markdown specification detailing the structural layout of the Microsoft Teams web interface, highlighting the key technical selectors and areas most critical for an LLM executing automated interactions (such as UI automation, scraping, or RPA).

---

# Specification: Microsoft Teams Web Interface Structure for LLM Automation

## 1. High-Level Architecture

The Microsoft Teams web application is built as a single-page application (SPA). Its primary layout relies on a persistent sidebar navigation system paired with a dynamic main content stage.

```
+-----------------------------------------------------------------------+
|  [1] App Header / Search Bar                                          |
+--------+--------------------------------------------------------------+
|        |  [3] List Pane (Contextual)                                  |
|  [2]   |  e.g., Chat list, Team channels, Activity feed               |
|  App   +--------------------------------------------------------------+
|  Bar   |                                                              |
|        |  [4] Main Content Stage                                      |
|        |  e.g., Chat thread, Document viewer, Tab apps                |
|        |                                                              |
|        +--------------------------------------------------------------+
|        |  [5] Compose Box / Input Area                                |
+--------+--------------------------------------------------------------+

```

---

## 2. Key Areas & Automation Targets

### [1] App Header & Global Search

Located at the very top of the interface. This area handles global commands, status changes, and quick navigation.

* **Key Use Cases for LLM:** Navigating to specific people/channels via search, checking current user status.
* **Critical Elements:**
* **Search Input:** Typically identifiable by `data-bi-id="search-input"` or `id="ngx-global-search-input"`.
* **User Profile Menu:** Trigger for status changes and settings; often contains `id="persona-avatar"`.



### [2] App Bar (Left-Most Rail)

The primary navigation strip containing global app icons (Activity, Chat, Teams, Calendar, Calls).

* **Key Use Cases for LLM:** Switching contexts (e.g., moving from "Chat" to "Calendar").
* **Critical Elements:**
* **Navigation Buttons:** Standardized buttons utilizing `data-control-name` attributes (e.g., `data-control-name="app-bar-chat"`, `data-control-name="app-bar-teams"`).



### [3] List Pane (Left Sidebar)

A dynamic list that updates based on the active selection in the App Bar. For example, if "Chat" is selected, this displays recent direct messages and groups.

* **Key Use Cases for LLM:** Selecting specific chat threads, identifying unread notifications, expanding/collapsing Teams channels.
* **Critical Elements (current Teams web / Fluent UI):**
* **Expand chevron (must open before listing):** `.fui-TreeItemLayout__expandIcon` — when collapsed the SVG uses `transform: rotate(0deg)`; parent `[role="treeitem"]` often has `aria-expanded="false"`. Always click collapsed expand icons (especially Recent / `RecentChats` folders) before scraping.
* **Chat rows:** `[role="treeitem"][data-testid="list-item"][data-item-type="chat"]`
* **Chat title:** `span[id^="title-chat-list-item_"]` — match by **text content** (e.g. `Opsoft Standup`). There is no `title="…"` attribute; never use `span[title="…"]`.
* **Unread indicator:** `[data-testid="dot-badge-container"]` inside the row, or `aria-labelledby` containing `chat_list_unread_text`
* **Legacy / fallback:** `data-tid="chat-list-item"`, `role="listitem"`
* **App Bar Chat:** `[data-control-name="app-bar-chat"]` — switch to Chat context first if needed.


### [4] Main Content Stage (Message History)

The central viewport where conversations occur. It contains the scrollable list of message bubbles, cards, and system events.

* **Key Use Cases for LLM:** Scraping historical context, extracting shared links/files, identifying who said what.
* **Critical Elements:**
* **Message Container:** Often wrapped in elements with `role="log"` or `data-tid="message-pane"`.
* **Individual Message Block:** Look for `data-tid="chat-pane-message"` or `data-mid`.
* **Sender Info & Timestamp:** Nested elements containing `data-tid="message-author"` and `data-tid="message-timestamp"`.



### [5] Compose Box (Input Area)

The text editor area at the bottom of the conversation view.

* **Key Use Cases for LLM:** Sending text replies, attaching files, triggering slash commands, or formatting responses.
* **Critical Elements:**
* **Rich Text Editor:** Teams uses a content-editable `div` or an iframe for messaging. Look for `role="textbox"` or `aria-label="Type a new message"`.
* **Send Button:** Accessible via `data-tid="send-button"` or `aria-label="Send"`.



---

## 3. Automation Strategy & Selectors

Because Microsoft Teams updates frequently and uses dynamic class names (often compiled via CSS-in-JS frameworks like Fluent UI), relying on standard CSS classes (e.g., `.hidden-abc123`) is highly discouraged.

### Recommended Selector Hierarchy

1. **`data-tid` / `data-bi-id`:** Dedicated test and business intelligence IDs inserted by Microsoft developers. These are the most stable selectors.
2. **`aria-label` / `role`:** Accessibility attributes required for screen readers. These rarely change because breaking them breaks accessibility compliance.
3. **Semantic Text Content:** Utilizing XPath text matches (e.g., `//button[contains(text(), 'Join')]`) for specific operational actions.

### Common Selector Mapping Table

| Element Function | Primary Target Attribute (Example) | Fallback Strategy |
| --- | --- | --- |
| **Compose Input** | `div[role="textbox"][aria-label="Type a new message"]` | `div[contenteditable="true"]` |
| **Send Message** | `button[data-tid="send-button"]` | `button[aria-label="Send"]` |
| **Chat List Item** | `[role="treeitem"][data-testid="list-item"][data-item-type="chat"]` | Title via `span[id^="title-chat-list-item_"]` |
| **Expand Recent / folders** | `.fui-TreeItemLayout__expandIcon` when `aria-expanded="false"` or SVG `rotate(0deg)` | Click before listing chats |
| **New Chat Button** | `button[data-tid="new-chat-button"]` | Search for `aria-label="New chat"` |

---

## 4. Key Automation Constraints & Challenges

* **Dynamic Virtualization:** In long chat threads or large team channels, Teams virtualizes the DOM. Messages that are scrolled out of view are actively destroyed and removed from the HTML structure. The LLM/automation script must physically scroll the container to load older history.
* **Iframes:** Certain tab applications (like Planner, Wiki, or custom corporate third-party apps) are loaded inside isolated `<iframe>` elements, requiring the automation agent to explicitly switch browser contexts.
* **Authentication/MFA:** Bypassing the initial login sequence usually requires persistent browser sessions (loading pre-authenticated user profile cookies/local storage) to avoid Multi-Factor Authentication (MFA) blocks during automation initialization.