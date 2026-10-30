'use strict';

const { ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags } = require('discord.js');
const colorManager = require('./colorManager');

function normalizeGroupText(value) {
  if (typeof value !== 'string') return value;
  return value
    // Keep prose punctuation readable: "القروب : الاسم" rather than "القروب: الاسم".
    .replace(/([\\p{L}_])\\s*:\\s*/gu, '$1 : ')
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

function responseTitle(content = '') {
  const value = String(content || '');
  if (/أوامر القروب|دليل الأوامر/.test(value)) return 'GROUP COMMANDS';
  if (/تم إنشاء القروب/.test(value)) return 'GROUP CREATED';
  if (/تم الإلغاء|تم إلغاء|أُلغي|ألغيت/.test(value)) return 'CANCELLED';
  if (/تم استخدام|مسبقًا|بالفعل/.test(value)) return 'ALREADY PROCESSED';
  if (/تأكيد|على وشك|لن يتم|اكتب:/.test(value)) return 'CONFIRMATION REQUIRED';
  if (/لا تملك|غير مسموح|مخصص|متاح ل|متاحة ل|صلاحية|ممنوع/.test(value)) return 'ACCESS DENIED';
  if (/غير موجود|لا توجد|لم يعد|لم يتم العثور|ليس ضمن|لا يمكن/.test(value)) return 'NOT FOUND';
  if (/تعذر|فشل|فشلت|غير صالح|خطأ|ناقص|مطلوب/.test(value)) return 'REQUEST FAILED';
  if (/تم\s|تمت\s|تم تنفيذ|تم تحديث|تم إضافة|تمت إضافة|تم حذف|تم تصفير|تم السماح|تم منع|تمت مغادرة/.test(value)) return 'SUCCESS';
  if (/اختر|حدد|أدخل|استخدم/.test(value)) return 'NEXT STEP';
  return 'GROUP UPDATE';
}

function accentNumber(value) {
  const raw = String(value || '').trim().replace(/^#/, '');
  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) ? parsed : 0x5865f2;
}

function responsePayload(payload = {}) {
  const data = { ...payload, allowedMentions: payload.allowedMentions || { parse: [] } };
  if (data.type && RESPONSE_TYPES[data.type]) data.title = data.title || RESPONSE_TYPES[data.type];
  delete data.type;
  if (typeof data.content === 'string' && !data.embeds?.length && !data.poll && !data.sticker_ids?.length) {
    const content = normalizeGroupText(data.content);
    const title = String(data.title || responseTitle(content));
    const accentColor = data.accentColor ?? colorManager.getColor?.();
    const thumbnail = data.thumbnail;
    delete data.accentColor;
    delete data.thumbnail;
    delete data.title;
    delete data.content;
    const container = new ContainerBuilder().setAccentColor(accentNumber(accentColor));
    const titleDisplay = new TextDisplayBuilder().setContent('## ' + title + '\n' + (content || 'تم تنفيذ الطلب.'));
    if (thumbnail) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(titleDisplay).setThumbnailAccessory(new ThumbnailBuilder().setURL(String(thumbnail))));
    else container.addTextDisplayComponents(titleDisplay);
    // Components V2 does not automatically display uploaded images; explicitly reference image attachments.
    const imageFiles = (Array.isArray(data.files) ? data.files : []).filter(file => /\.(png|jpe?g|webp|gif)$/i.test(String(file?.name || file?.attachment?.name || '')));
    if (imageFiles.length) {
      const gallery = new MediaGalleryBuilder().addItems(...imageFiles.slice(0, 10).map(file =>
        new MediaGalleryItemBuilder().setURL('attachment://' + String(file.name || file.attachment?.name))
      ));
      container.addMediaGalleryComponents(gallery);
    }
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


const RESPONSE_TYPES = Object.freeze({
  success: 'SUCCESS',
  failure: 'REQUEST FAILED',
  permission: 'ACCESS DENIED',
  confirmation: 'CONFIRMATION REQUIRED',
  cancelled: 'CANCELLED',
  empty: 'NO RESULTS',
  info: 'GROUP UPDATE'
});

function typedResponse(type, title, content, extra = {}) {
  const normalizedType = Object.prototype.hasOwnProperty.call(RESPONSE_TYPES, type) ? type : 'info';
  return responsePayload({
    ...extra,
    title: String(title || RESPONSE_TYPES[normalizedType]),
    type: normalizedType,
    content: String(content || ''),
    allowedMentions: extra.allowedMentions || { parse: [] }
  });
}
function successResponse(title, content, extra = {}) { return typedResponse('success', title, content, extra); }
function failureResponse(title, content, extra = {}) { return typedResponse('failure', title, content, extra); }
function permissionResponse(title, content, extra = {}) { return typedResponse('permission', title, content, extra); }
function confirmationResponse(title, content, extra = {}) { return typedResponse('confirmation', title, content, extra); }
function cancelledResponse(title, content, extra = {}) { return typedResponse('cancelled', title, content, extra); }
function emptyResponse(title, content, extra = {}) { return typedResponse('empty', title, content, extra); }

module.exports = { normalizeGroupText, responsePayload, typedResponse, successResponse, failureResponse, permissionResponse, confirmationResponse, cancelledResponse, emptyResponse, RESPONSE_TYPES };
