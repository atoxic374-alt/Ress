const interactionRouter = require('./interactionRouter');

let ticketRouterRegistered = false;

function registerTicketInteractionRouter(handler) {
  if (ticketRouterRegistered || typeof handler !== 'function') return;

  interactionRouter.register('ticket_', async (interaction, context = {}) => handler(interaction, context), {
    name: 'ticket-system',
    priority: 70,
    types: ['button', 'modal', 'stringSelect'],
    // Ticket creation may include several Discord API calls (channel creation,
    // intro message, logging, and persistence). Keep it below the interaction
    // token lifetime, but do not let the router's default timeout interrupt a
    // claim while the ticket is still being created.
    timeoutMs: 180000
  });

  ticketRouterRegistered = true;
}

module.exports = {
  registerTicketInteractionRouter
};
