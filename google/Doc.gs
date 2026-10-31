// Each group's executive summaries, in its own Google Doc (see Code.gs for
// how requests arrive): a section per summary in the doc's Summary tab,
// newest first, which the client goes through on calls and adds to, and
// which Cade reads back after (see src/doc.js). A section starts with a
// level 2 heading, found again by a named range around it, and runs to the
// next heading of level 2 or above.

const PREFIX = "cade:";

// A new doc called `title`, for `npm run group`, and its ID.
function createDoc(title) {
  return DocumentApp.create(title).getId();
}

// Writes the section and returns its address: the tab's, opened at the
// section's heading.
function write(docId, title, key, blocks) {
  const { doc, tab } = tabFor(docId, title);
  const documentTab = tab.asDocumentTab();
  const body = documentTab.getBody();
  let at = 0;
  const old = sectionHeading(documentTab, key);
  if (old) {
    at = body.getChildIndex(old.heading);
    const end = sectionEnd(body, at);
    old.range.remove();
    for (let i = end - 1; i >= at; i--) removeChild(body, i);
  }
  let list = null;
  let heading = null;
  for (const block of blocks) {
    const element = insert(body, at++, block);
    // Bullets in a row are one list, so they nest.
    if (block.type === "item") {
      if (list) element.setListId(list);
      else list = element;
    } else {
      list = null;
    }
    if (block.type === "heading" && block.level === 2) {
      documentTab.addNamedRange(PREFIX + key, documentTab.newRange().addElement(element).build());
      heading = element;
    }
  }
  // Which of the headings with this text it is, as the doc may have several
  // (two summaries written the same day).
  const text = heading && heading.getText();
  let nth = 0;
  for (let i = 0; heading && i <= body.getChildIndex(heading); i++) {
    const child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH && headingLevel(child.asParagraph()) && child.asParagraph().getText() === text) nth++;
  }
  doc.saveAndClose();
  const address = `https://docs.google.com/document/d/${docId}/edit?tab=${tab.getId()}`;
  const id = heading ? headingId(docId, tab.getId(), text, nth) : null;
  return id ? `${address}#heading=${id}` : address;
}

// The ID Docs gives the `nth` heading reading `text` in the tab, which a
// link opens the doc at, or null. Only the Docs API has it.
function headingId(docId, tabId, text, nth) {
  try {
    const found = Docs.Documents.get(docId, { includeTabsContent: true });
    const search = (tabs) => {
      for (const tab of tabs || []) {
        if (tab.tabProperties.tabId === tabId) return tab;
        const child = search(tab.childTabs);
        if (child) return child;
      }
      return null;
    };
    const tab = search(found.tabs);
    let seen = 0;
    for (const element of tab.documentTab.body.content) {
      const paragraph = element.paragraph;
      if (!paragraph || !paragraph.paragraphStyle || !paragraph.paragraphStyle.headingId) continue;
      const words = paragraph.elements.map((part) => (part.textRun ? part.textRun.content : "")).join("").replace(/\n$/, "");
      if (words === text && ++seen === nth) return paragraph.paragraphStyle.headingId;
    }
  } catch (error) {
    // The tab's address will do.
  }
  return null;
}

function insert(body, at, block) {
  const Heading = DocumentApp.ParagraphHeading;
  if (block.type === "item") {
    const item = body.insertListItem(at, "").setGlyphType(DocumentApp.GlyphType.BULLET).setNestingLevel(block.level || 0);
    const text = item.editAsText();
    for (const part of block.parts) {
      if (!part.text) continue;
      const start = text.getText().length;
      text.appendText(part.text);
      text.setLinkUrl(start, start + part.text.length - 1, part.link || null);
    }
    return item;
  }
  const heading = block.type === "paragraph" ? Heading.NORMAL : block.level === 2 ? Heading.HEADING2 : Heading.HEADING3;
  const paragraph = body.insertParagraph(at, block.text).setHeading(heading);
  paragraph.setItalic(Boolean(block.italic));
  return paragraph;
}

// The section's elements, or null if its heading is gone.
function read(docId, title, key) {
  const tab = findTab(DocumentApp.openById(docId), title);
  if (!tab) return null;
  const documentTab = tab.asDocumentTab();
  const found = sectionHeading(documentTab, key);
  if (!found) return null;
  const body = documentTab.getBody();
  const start = body.getChildIndex(found.heading);
  const end = sectionEnd(body, start);
  const elements = [];
  for (let i = start + 1; i < end; i++) {
    const child = body.getChild(i);
    const type = child.getType();
    if (type === DocumentApp.ElementType.LIST_ITEM) {
      const item = child.asListItem();
      elements.push({ type: "item", level: item.getNestingLevel(), text: item.getText(), links: links(item.editAsText()) });
    } else if (type === DocumentApp.ElementType.PARAGRAPH) {
      const paragraph = child.asParagraph();
      const level = headingLevel(paragraph);
      elements.push({ type: level ? "heading" : "paragraph", level, text: paragraph.getText(), links: links(paragraph.editAsText()) });
    }
  }
  return elements;
}

// The section's heading paragraph and its named range, or null.
function sectionHeading(documentTab, key) {
  for (const range of documentTab.getNamedRanges(PREFIX + key)) {
    const element = range.getRange().getRangeElements()[0];
    if (!element) continue;
    let heading = element.getElement();
    while (heading && heading.getType() !== DocumentApp.ElementType.PARAGRAPH) heading = heading.getParent();
    if (heading && heading.getParent().getType() === DocumentApp.ElementType.BODY_SECTION) return { heading, range };
  }
  return null;
}

// The index after the section starting at `start`: the next heading of
// level 2 or above, or the end of the body.
function sectionEnd(body, start) {
  for (let i = start + 1; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const level = headingLevel(child.asParagraph());
    if (level && level <= 2) return i;
  }
  return body.getNumChildren();
}

// 1–6 for a heading (the title counts as 1), or 0.
function headingLevel(paragraph) {
  const Heading = DocumentApp.ParagraphHeading;
  const levels = [Heading.TITLE, Heading.HEADING1, Heading.HEADING2, Heading.HEADING3, Heading.HEADING4, Heading.HEADING5, Heading.HEADING6];
  const at = levels.indexOf(paragraph.getHeading());
  return at <= 0 ? (at === 0 ? 1 : 0) : at;
}

// The body's last paragraph can't be removed, so an empty one is added
// after it first.
function removeChild(body, i) {
  if (i === body.getNumChildren() - 1) body.appendParagraph("");
  body.getChild(i).removeFromParent();
}

// The addresses linked from a piece of text, each once.
function links(text) {
  const found = [];
  const content = text.getText();
  const starts = text.getTextAttributeIndices();
  for (const start of starts) {
    if (start >= content.length) continue;
    const url = text.getLinkUrl(start);
    if (url && found.indexOf(url) === -1) found.push(url);
  }
  return found;
}

// The doc and its tab called `title`, made if there is none. A doc with
// only an empty tab, as a new doc has, has it renamed instead, so the doc
// isn't left with an empty tab.
function tabFor(docId, title) {
  let doc = DocumentApp.openById(docId);
  let tab = findTab(doc, title);
  if (tab) return { doc, tab };
  const tabs = doc.getTabs();
  let made = false;
  if (tabs.length === 1 && !tabs[0].getChildTabs().length && !tabs[0].asDocumentTab().getBody().getText().trim()) {
    try {
      Docs.Documents.batchUpdate(
        { requests: [{ updateDocumentTabProperties: { tabProperties: { tabId: tabs[0].getId(), title }, fields: "title" } }] },
        docId,
      );
      made = true;
    } catch (error) {
      // Renaming isn't available: a tab is added instead.
    }
  }
  if (!made) Docs.Documents.batchUpdate({ requests: [{ addDocumentTab: { tabProperties: { title } } }] }, docId);
  // The new tab can take a moment to show up to DocumentApp.
  for (let tries = 0; !tab && tries < 5; tries++) {
    if (tries) Utilities.sleep(1000);
    doc = DocumentApp.openById(docId);
    tab = findTab(doc, title);
  }
  if (!tab) throw new Error(`couldn't make the ${title} tab`);
  return { doc, tab };
}

// The tab called `title`, at any depth, or null.
function findTab(doc, title) {
  const search = (tabs) => {
    for (const tab of tabs) {
      if (tab.getTitle() === title) return tab;
      const child = search(tab.getChildTabs());
      if (child) return child;
    }
    return null;
  };
  return search(doc.getTabs());
}

// A task's notes page: an empty tab called `title` under the `parent` tab,
// made if the doc has none, for notes the team writes by hand. Cade never
// writes in it. Returns the page's address and tab ID.
function addTaskTab(docId, parent, title) {
  const { tab: parentTab } = tabFor(docId, parent);
  const made = Docs.Documents.batchUpdate(
    { requests: [{ addDocumentTab: { tabProperties: { title, parentTabId: parentTab.getId() } } }] },
    docId,
  );
  const tabId = made.replies[0].addDocumentTab.tabProperties.tabId;
  return { url: `https://docs.google.com/document/d/${docId}/edit?tab=${tabId}`, tabId };
}

// A task's exported thread: `text` as the whole content of its tab under the
// `parent` tab. The tab `tabId` is written again if it's still in the doc;
// otherwise a tab called `title` already under the parent is (one an earlier
// export made but didn't get to record, as titles must be unique in a doc, so
// a second can't be made); otherwise a new one is made. Returns the tab's
// address and ID.
function exportTab(docId, parent, title, tabId, text) {
  let doc = DocumentApp.openById(docId);
  let tab = tabId ? doc.getTab(tabId) : null;
  if (!tab) {
    const old = findTab(doc, title);
    const above = old && old.getParentTab();
    if (above && above.getTitle() === parent) tab = old;
  }
  if (!tab) {
    const id = addTaskTab(docId, parent, title).tabId;
    // The new tab can take a moment to show up to DocumentApp.
    for (let tries = 0; !tab && tries < 5; tries++) {
      if (tries) Utilities.sleep(1000);
      doc = DocumentApp.openById(docId);
      tab = doc.getTab(id);
    }
    if (!tab) throw new Error("couldn't make the export tab");
  }
  tab.asDocumentTab().getBody().setText(text);
  doc.saveAndClose();
  return { url: `https://docs.google.com/document/d/${docId}/edit?tab=${tab.getId()}`, tabId: tab.getId() };
}
