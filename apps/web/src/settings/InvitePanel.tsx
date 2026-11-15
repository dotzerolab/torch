import { type InviteCreateInput, inviteCreateInput } from '@torch/shared/mutations/admin';
import type { Role } from '@torch/shared/permissions';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { Select } from '../design/components/Select.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';

type PanelTeam = { id: string; key: string; name: string };

/**
 * The invite form: an email, a role (only those the person may hand out), the teams (a guest needs at least one)
 * and the language of the email. It checks what it can before sending, shows the translated reason of a refusal
 * and leaves the rest (what happens after a success) to the screen.
 */
export function InvitePanel({
  teams,
  roles,
  onSubmit,
}: {
  teams: PanelTeam[];
  roles: Role[];
  onSubmit: (input: InviteCreateInput) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(
    roles.includes('member') ? 'member' : (roles[0] ?? 'member'),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [language, setLanguage] = useState<'en' | 'it'>(locale);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleTeam(id: string, checked: boolean) {
    setTeamIds((current) => (checked ? [...current, id] : current.filter((other) => other !== id)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!inviteCreateInput.shape.email.safeParse(email).success) {
      setError(t('settings.invite.invalidEmail'));
      return;
    }
    if (role === 'guest' && teamIds.length === 0) {
      setError(t('settings.invite.guestNeedsTeam'));
      return;
    }
    const input = inviteCreateInput.safeParse({ email, role, teamIds, locale: language });
    if (!input.success) {
      setError(t('settings.invite.invalidEmail'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit(input.data);
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate data-testid="invite-form">
      <div className="form__row">
        <label className="form__label" htmlFor={`${ids}-email`}>
          {t('settings.invite.email')}
        </label>
        <Input
          id={`${ids}-email`}
          type="email"
          autoComplete="off"
          value={email}
          invalid={error !== null && !inviteCreateInput.shape.email.safeParse(email).success}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="form__row">
        <span className="form__label">{t('settings.invite.role')}</span>
        <Select
          label={t('settings.invite.role')}
          value={role}
          onValueChange={(value) => setRole(value as Role)}
          options={roles.map((value) => ({ value, label: t(`settings.role.${value}`) }))}
        />
      </div>
      <fieldset className="form__row form__fieldset">
        <legend className="form__label">{t('settings.invite.teams')}</legend>
        <p className="form__hint">{t('settings.invite.teamsHint')}</p>
        {teams.length === 0 ? (
          <p className="form__hint">{t('settings.invite.noTeams')}</p>
        ) : (
          <ul className="checklist">
            {teams.map((team) => (
              <li key={team.id}>
                <label className="checklist__item">
                  <input
                    type="checkbox"
                    checked={teamIds.includes(team.id)}
                    onChange={(event) => toggleTeam(team.id, event.target.checked)}
                  />
                  <span>{team.name}</span>
                  <span className="checklist__key">{team.key}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="form__row">
        <span className="form__label">{t('settings.invite.language')}</span>
        <Select
          label={t('settings.invite.language')}
          value={language}
          onValueChange={(value) => setLanguage(value as 'en' | 'it')}
          options={[
            { value: 'en', label: t('settings.language.en') },
            { value: 'it', label: t('settings.language.it') },
          ]}
        />
      </div>
      {error ? (
        <p className="form__error" role="alert" data-testid="invite-error">
          {error}
        </p>
      ) : null}
      <div className="form__actions">
        <Button type="submit" variant="primary" loading={busy} data-testid="invite-submit">
          {busy ? t('settings.invite.sending') : t('settings.invite.submit')}
        </Button>
      </div>
    </form>
  );
}
