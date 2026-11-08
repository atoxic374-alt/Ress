'use strict';

function discordErrorCode(error) {
  return Number(error?.code ?? error?.rawError?.code ?? error?.data?.code);
}

async function fetchExistingPanelMessage(channel, messageId) {
  if (!messageId) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (discordErrorCode(error) === 10008 || Number(error?.status) === 404) return null;
    throw error;
  }
}

async function deliverTicketPanel(channel, payload, existingMessage = null) {
  const result = existingMessage?.editable
    ? await existingMessage.edit(payload)
    : await channel.send(payload);

  if (!result?.id) {
    const error = new Error('Discord did not return a message ID after delivering the ticket panel.');
    error.code = 'TICKET_PANEL_NO_MESSAGE_ID';
    throw error;
  }

  return result;
}

function describeTicketPanelDeliveryError(error, { includesImage = false } = {}) {
  const code = discordErrorCode(error);
  if (code === 50001) {
    return `❌ لم يصل بانل التكت: البوت لا يستطيع الوصول إلى القناة. تأكد من صلاحية View Channel للقناة ${includesImage ? 'وAttach Files للصور' : ''}.`;
  }
  if (code === 50013) {
    return `❌ لم يصل بانل التكت: صلاحيات البوت غير كافية. فعّل View Channel وSend Messages${includesImage ? ' وAttach Files' : ''} للقناة.`;
  }
  if (code === 10003) {
    return '❌ لم يصل بانل التكت: القناة المحددة لم تعد موجودة. اختر قناة تكت صالحة من جديد.';
  }
  if (error?.code === 'TICKET_PANEL_NO_MESSAGE_ID') {
    return '❌ لم يؤكد Discord إنشاء رسالة البانل، لذلك لم أعتبر الإرسال ناجحًا.';
  }
  return `❌ تعذر إرسال بانل التكت. لم تُسجّل العملية كنجاح${Number.isFinite(code) ? ` (Discord ${code})` : ''}. تحقق من صلاحيات القناة ثم أعد المحاولة.`;
}

module.exports = {
  discordErrorCode,
  fetchExistingPanelMessage,
  deliverTicketPanel,
  describeTicketPanelDeliveryError
};
