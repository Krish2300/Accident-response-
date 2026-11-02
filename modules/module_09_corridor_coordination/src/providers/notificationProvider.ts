/**
 * Module 9 - simulated notifications.
 *
 * There is no messaging provider in this repository. This provider records the
 * *intent* to notify and always reports `delivered: false` with status
 * `SUPPRESSED`: no message leaves the process. Callers persist that outcome
 * verbatim, so a notification row can never claim a delivery that did not
 * happen.
 */

import type { NotificationProvider, NotificationRequest, NotificationResult } from '@resus/core';

export const MOCK_NOTIFICATION_PROVIDER_NAME = 'mock-notification';

export class MockNotificationProvider implements NotificationProvider {
  readonly providerName = MOCK_NOTIFICATION_PROVIDER_NAME;
  /** Never a real provider. No consumer may present these as delivered. */
  readonly isLive = false;

  async notify(_request: NotificationRequest): Promise<NotificationResult> {
    return {
      providerName: this.providerName,
      isLive: false,
      delivered: false,
      status: 'SUPPRESSED',
      detail: 'Simulated notification: no message was sent and none left the system.',
    };
  }
}
