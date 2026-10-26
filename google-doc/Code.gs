// Keeps each group's executive summaries in a Google Doc for the Cade
// Worker: a section per summary in the doc's Summary tab, newest first,
// which the client goes through on calls and adds to, and which Cade reads
// back after (see src/doc.js). It is attached to the first group's doc, as
// `npm run doc:create` makes it, separate from the Google Sheet's, and runs
// as whoever deployed it, so it can edit the other groups' docs too, if they
// can.
//
// Each request is { secret, action, … }. `secret` must match SECRET, defined
// in Secret.gs next to this file, which `npm run doc:create` makes along with
// the Worker's DOC_SECRET. The actions:
//   write   { docId, tab, key, blocks }   → { url }, the section `key`
//                                           written, in place of the old one
//                                           or at the top; the tab is made
//                                           if the doc has none
//   read    { docId, tab, key }           → { elements }, the section as it
//                                           now reads, or null if it's gone
// A section starts with a level 2 heading, found again by a named range
// around it, and runs to the next heading of level 2 or above.

const PREFIX = "cade:";

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (typeof SECRET === "undefined" || !SECRET || body.secret !== SECRET) {
    return reply({ ok: false, error: "unauthorized" });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (body.action === "write") return reply({ ok: true, url: write(body.docId, body.tab, body.key, body.blocks) });
    if (body.action === "read") return reply({ ok: true, elements: read(body.docId, body.tab, body.key) });
    return reply({ ok: false, error: `unknown action ${body.action}` });
  } catch (error) {
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    lock.releaseLock();
  }
}

// Writes the section and returns the tab's address.
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
    }
  }
  doc.saveAndClose();
  return `https://docs.google.com/document/d/${docId}/edit?tab=${tab.getId()}`;
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
  doc = DocumentApp.openById(docId);
  tab = findTab(doc, title);
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

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Run once in the Apps Script editor after creating the script, to approve
// its access to your docs; the web app can't ask for it itself.
function authorize() {
  Logger.log(`Authorized as ${Session.getEffectiveUser().getEmail()}.`);
}
