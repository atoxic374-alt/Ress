'use strict';

const assert = require('node:assert/strict');
const {
  fetchExistingPanelMessage,
  deliverTicketPanel,
  describeTicketPanelDeliveryError
} = require('./utils/ticketPanelDelivery');

async function run() {
  const sent = { id: 'ticket-panel-message' };
  const channel = { send: async () => sent };
  assert.equal(await deliverTicketPanel(channel, { content: 'panel' }), sent);

  const sendFailure = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await assert.rejects(
    () => deliverTicketPanel({ send: async () => { throw sendFailure; } }, {}),
    error => error === sendFailure
  );
  assert.match(describeTicketPanelDeliveryError(sendFailure), /لم يصل بانل التكت/);

  const editFailure = Object.assign(new Error('Missing Access'), { code: 50001 });
  await assert.rejects(
    () => deliverTicketPanel({}, {}, { editable: true, edit: async () => { throw editFailure; } }),
    error => error === editFailure
  );

  const missingMessage = await fetchExistingPanelMessage({
    messages: { fetch: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 }); } }
  }, 'deleted-message');
  assert.equal(missingMessage, null);

  await assert.rejects(
    () => fetchExistingPanelMessage({
      messages: { fetch: async () => { throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }); } }
    }, 'restricted-message'),
    error => error.code === 50001
  );

  await assert.rejects(
    () => deliverTicketPanel({ send: async () => null }, {}),
    error => error.code === 'TICKET_PANEL_NO_MESSAGE_ID'
  );
  console.log('ticket panel delivery checks passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
