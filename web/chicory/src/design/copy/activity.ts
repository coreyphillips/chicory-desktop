import { sats } from './shared';

/** The Activity sheet: its grip, rows, filters, search and empty states. */
export const activity = {
  /** The grip at the top of the sheet, which opens the whole list. */
  sheet: 'Activity',
  row: (title: string, value: number, status: string) =>
    `${title}, ${sats(value)}, ${status}`,
  rowHidden: (title: string, status: string) =>
    `${title}, amount hidden, ${status}`,
  /** A request that lets the payer choose the amount. */
  rowOpen: (title: string, status: string) => `${title}, any amount, ${status}`,
  rowHint: 'Opens the payment details.',
  filters: {
    Sent: 'Sent',
    Received: 'Received',
    Requests: 'Requests',
    Pending: 'Pending',
  },
  search: 'Search activity',
  clearSearch: 'Clear search',
  noMatches: (query: string) => `No payments match “${query}”.`,
  empty: 'No activity yet.',
  noFiltered: (filter: string) => `No ${filter.toLowerCase()} payments.`,
  reusedAddress: 'Address reused',
  legacy: 'Older request',
  unavailable: 'Status unavailable',
  refreshFailed: (error: string) =>
    `Could not refresh. Showing the last known state. ${error}`,
  retry: 'Tries the refresh again.',
};
