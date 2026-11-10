import { Extension } from '@tiptap/core';

export const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',
  addGlobalAttributes() {
    return [{ types: ['paragraph', 'heading'], attributes: {
      indent: {
        default: 0,
        parseHTML: element => Math.max(0, Math.min(8, Math.round((parseInt(element.style.marginLeft, 10) || 0) / 32))),
        renderHTML: attrs => attrs.indent ? { style: `margin-left: ${attrs.indent * 32}px` } : {},
      },
    } }];
  },
  addCommands() {
    const change = delta => ({ state, tr, dispatch }) => {
      let changed = false;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (!['paragraph', 'heading'].includes(node.type.name)) return;
        const indent = Math.max(0, Math.min(8, (node.attrs.indent || 0) + delta));
        if (indent === node.attrs.indent) return;
        changed = true;
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent });
      });
      return changed;
    };
    return { increaseParagraphIndent: () => change(1), decreaseParagraphIndent: () => change(-1) };
  },
});

export function indentEditor(editor, direction) {
  const chain = editor.chain().focus();
  if (editor.isActive('listItem')) return direction > 0 ? chain.sinkListItem('listItem').run() : chain.liftListItem('listItem').run();
  return direction > 0 ? chain.increaseParagraphIndent().run() : chain.decreaseParagraphIndent().run();
}

export function removeEditorFormatting(editor) {
  return editor.chain().focus().unsetAllMarks().clearNodes()
    .resetAttributes('paragraph', ['indent', 'textAlign']).run();
}
