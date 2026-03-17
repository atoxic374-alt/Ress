const interactionRouter = require('./interactionRouter');

let ticketRouterRegistered = false;

function registerTicketInteractionRouter(handler) {
  if (ticketRouterRegistered || typeof handler !== 'function') return;

  interactionRouter.register('ticket_', async (interaction, context = {}) => handler(interaction, context), {
    name: 'ticket-system',
    priority: 70,
    types: ['button', 'modal', 'stringSelect']
  });

  ticketRouterRegistered = true;
}

module.exports = {
  registerTicketInteractionRouter
};
