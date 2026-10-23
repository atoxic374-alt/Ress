'use strict';

const { ContainerBuilder, TextDisplayBuilder, MessageFlags } = require('discord.js');

function normalizeGroupText(value) {
  if (typeof value !== 'string') return value;
  return value
    // Keep prose punctuation readable: "القروب : الاسم" rather than "القروب: الاسم".
    .replace(/([\u0600-\u06FF])\s*:\s*/g, '$1 : ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeComponent(value) {
  if (Array.isArray(value)) return value.map(normalizeComponent);
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const key of Object.keys(out)) {
    if (key === 'content' && typeof out[key] === 'string') out[key] = normalizeGroupText(out[key]);
    else if (out[key] && typeof out[key] === 'object') out[key] = normalizeComponent(out[key]);
  }
  return out;
}

function responsePayload(payload = {}) {
  const data = { ...payload, allowedMentions: payload.allowedMentions || { parse: [] } };
  if (typeof data.content === 'string' && !data.embeds?.length && !data.poll && !data.sticker_ids?.length) {
    const content = normalizeGroupText(data.content);
    delete data.content;
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(content || 'تم تنفيذ الطلب.')
    );
    const components = Array.isArray(data.components) ? data.components.map(component =>
      typeof component?.toJSON === 'function' ? component : normalizeComponent(component)
    ) : [];
    data.components = [container.toJSON(), ...components];
    data.flags = Number(data.flags || 0) | MessageFlags.IsComponentsV2;
  } else if (Array.isArray(data.components)) {
    data.components = data.components.map(component =>
      typeof component?.toJSON === 'function' ? component : normalizeComponent(component)
    );
  }
  return data;
}

module.exports = { normalizeGroupText, responsePayload };
