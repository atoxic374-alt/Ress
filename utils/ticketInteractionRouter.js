const interactionRouter = require('./interactionRouter');

let ticketRouterRegistered = false;

function registerTicketInteractionRouter(handler) {
  if (ticketRouterRegistered || typeof handler !== 'function') return;

  interactionRouter.register('ticket_', async (interaction, context = {}) => handler(interaction, context), {
    name: 'ticket-system',
    priority: 70,
    types: ['button', 'modal', 'stringSelect'],
    // Ticket creation should normally finish within a few seconds. This is a
    // safety ceiling, not the expected duration; the handler acknowledges the
    // interaction immediately and the router must not use its generic timeout.
    timeoutMs: 30000
  });

  ticketRouterRegistered = true;
}

module.exports = {
  registerTicketInteractionRouter
};
