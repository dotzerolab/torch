import { useLiveQuery } from '@tanstack/react-db';
import { type ProfileUpdateInput, profileUpdateInput } from '@torch/shared/mutations/admin';
import { type FormEvent, useId, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { Select } from '../design/components/Select.tsx';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { awaitSynced, type SyncedMember } from '../sync/collections.ts';
import { membersCollection, useShape } from '../sync/shapes.ts';
import { adminApi } from './admin-api.ts';

const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const knownTimeZones = (): string[] =>
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

function ProfileForm({ workspaceId, me }: { workspaceId: string; me: SyncedMember }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const ids = useId();
  const [name, setName] = useState(me.name);
  const [handle, setHandle] = useState(me.handle);
  const [language, setLanguage] = useState<'en' | 'it'>(me.locale);
  // The time zone never travels in a shape, so the field starts empty: empty means "keep the one I have".
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const patch: Record<string, string> = {};
    if (name.trim() !== me.name) patch.name = name.trim();
    if (handle !== me.handle) patch.handle = handle;
    if (language !== me.locale) patch.locale = language;
    if (timezone.trim() !== '') patch.timezone = timezone.trim();
    if (Object.keys(patch).length === 0) return;
    const input = profileUpdateInput.safeParse(patch);
    if (!input.success) {
      setError(t('settings.profile.invalid'));
      return;
    }
    setBusy(true);
    try {
      const { txid } = await adminApi.updateProfile(workspaceId, input.data as ProfileUpdateInput);
      await awaitSynced(membersCollection(workspaceId), txid);
      setTimezone('');
      toast.show({ message: t('settings.profile.saved') });
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form form--wide" onSubmit={submit} noValidate data-testid="profile-form">
      <div className="form__row">
        <label className="form__label" htmlFor={`${ids}-name`}>
          {t('settings.profile.name')}
        </label>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form__row">
        <label className="form__label" htmlFor={`${ids}-handle`}>
          {t('settings.profile.handle')}
        </label>
        <Input
          id={`${ids}-handle`}
          value={handle}
          maxLength={32}
          autoCapitalize="none"
          className="field--mono"
          onChange={(e) => setHandle(e.target.value)}
        />
        <p className="form__hint">{t('settings.profile.handleHint')}</p>
      </div>
      <div className="form__row">
        <span className="form__label">{t('settings.profile.language')}</span>
        <Select
          label={t('settings.profile.language')}
          value={language}
          onValueChange={(value) => setLanguage(value as 'en' | 'it')}
          options={[
            { value: 'en', label: t('settings.language.en') },
            { value: 'it', label: t('settings.language.it') },
          ]}
        />
        <p className="form__hint">{t('settings.profile.languageHint')}</p>
      </div>
      <div className="form__row">
        <label className="form__label" htmlFor={`${ids}-tz`}>
          {t('settings.profile.timezone')}
        </label>
        <div className="form__inline">
          <Input
            id={`${ids}-tz`}
            list={`${ids}-zones`}
            value={timezone}
            placeholder={deviceTimeZone()}
            autoComplete="off"
            onChange={(e) => setTimezone(e.target.value)}
          />
          <Button onClick={() => setTimezone(deviceTimeZone())}>
            {t('settings.profile.useDevice')}
          </Button>
        </div>
        <datalist id={`${ids}-zones`}>
          {knownTimeZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="form__hint">{t('settings.profile.timezoneHint')}</p>
      </div>
      {error ? (
        <p className="form__error" role="alert" data-testid="profile-error">
          {error}
        </p>
      ) : null}
      <div className="form__actions">
        <Button type="submit" variant="primary" loading={busy} data-testid="profile-save">
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** The signed-in person's own name, handle, language and time zone. Every role has this page. */
export function ProfilePage({ workspace }: { workspace: SessionWorkspace }) {
  const t = useT();
  const collection = useShape({ kind: 'members', workspaceId: workspace.id });
  const { data, isReady } = useLiveQuery({ query: (q) => q.from({ member: collection }) });
  const me = data.find((member) => member.id === workspace.memberId);

  return (
    <div className="settings-page" data-testid="profile-page">
      <div className="settings-page__head">
        <h2 className="settings-page__title">{t('settings.profile.title')}</h2>
      </div>
      {!isReady || !me ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : (
        // A new synced profile (saved here or on another device) starts the form again from it.
        <ProfileForm
          key={`${me.name}|${me.handle}|${me.locale}`}
          workspaceId={workspace.id}
          me={me}
        />
      )}
    </div>
  );
}
