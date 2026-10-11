import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHANNEL_IDS,
  PushPayloadError,
  buildFcmMessageParts,
  normalizePushPayload,
} from '../lib/push/payload.js';

describe('normalizePushPayload', () => {
  it('requires title and body', () => {
    assert.throws(() => normalizePushPayload({}), (err) => err instanceof PushPayloadError);
    assert.throws(() => normalizePushPayload({ title: 'Hi' }), (err) => err instanceof PushPayloadError);
  });

  it('defaults channel from urgency and style', () => {
    const quiet = normalizePushPayload({ title: 'T', body: 'B', urgency: 'low' });
    assert.equal(quiet.channel, 'quiet');

    const urgent = normalizePushPayload({ title: 'T', body: 'B', urgency: 'high' });
    assert.equal(urgent.channel, 'urgent');

    const progress = normalizePushPayload({
      title: 'T',
      body: 'B',
      style: 'progress',
      progress: { current: 1, max: 10 },
    });
    assert.equal(progress.channel, 'progress');
    assert.equal(progress.ongoing, true);
  });

  it('parses actions and https images', () => {
    const payload = normalizePushPayload({
      title: 'Draft ready',
      body: 'Tap to open',
      deep_link: '/agents/runs/abc',
      image_url: 'https://cdn.example.com/pic.png',
      actions: [{ id: 'open_draft', label: 'Open draft' }],
      notification_key: 'draft:1',
    });
    assert.equal(payload.onlyAlertOnce, true);
    assert.equal(payload.actions[0]?.id, 'open_draft');
    assert.equal(payload.imageUrl, 'https://cdn.example.com/pic.png');
  });

  it('rejects http images and reserved data keys', () => {
    assert.throws(
      () => normalizePushPayload({ title: 'T', body: 'B', image_url: 'http://evil.example/x.png' }),
      /https/
    );
    assert.throws(
      () => normalizePushPayload({ title: 'T', body: 'B', data: { curtis_title: 'nope' } }),
      /reserved/
    );
  });

  it('requires progress for progress style and image for big_picture', () => {
    assert.throws(
      () => normalizePushPayload({ title: 'T', body: 'B', style: 'progress' }),
      /progress is required/
    );
    assert.throws(
      () => normalizePushPayload({ title: 'T', body: 'B', style: 'big_picture' }),
      /image_url is required/
    );
  });

  it('requires ongoing when request_promoted', () => {
    assert.throws(
      () =>
        normalizePushPayload({
          title: 'T',
          body: 'B',
          request_promoted: true,
          ongoing: false,
        }),
      /request_promoted/
    );
  });
});

describe('buildFcmMessageParts', () => {
  it('emits curtis data and android notification channel', () => {
    const payload = normalizePushPayload({
      title: 'Ship it',
      body: 'Release ready',
      subtitle: 'Jira · REL-1',
      channel: 'urgent',
      notification_key: 'release:REL-1',
      deep_link: '/agents/runs/r1',
      actions: [{ id: 'view_issue', label: 'View' }],
    });
    const fcm = buildFcmMessageParts(payload);
    assert.equal(fcm.data.curtis_v, '1');
    assert.equal(fcm.data.curtis_channel_id, CHANNEL_IDS.urgent);
    assert.equal(fcm.data.curtis_deep_link, '/agents/runs/r1');
    assert.equal(fcm.android.notification.channel_id, CHANNEL_IDS.urgent);
    assert.equal(fcm.android.notification.tag, 'release:REL-1');
    assert.equal(fcm.android.collapse_key, 'release:REL-1');
    assert.equal(fcm.android.notification.click_action, 'CURTIS_OPEN');
    assert.match(fcm.data.curtis_actions ?? '', /view_issue/);
  });
});
