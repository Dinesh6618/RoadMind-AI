import { Notice } from '../../components'

/**
 * Where an emailed link went and what to do about it - shared by the first-run setup and the staff registration, so
 * the wording is the same everywhere. `known` is false when we only know the configured mode, not the last outcome.
 */
export default function DeliveryNotice({ delivery, outboxDir, error, host, known = true }) {
  if (delivery === 'smtp') {
    return known
      ? <Notice kind="ok">The email was handed to {host || 'the mail server'}. Check the inbox of that address (and the spam folder); it usually arrives within a minute.</Notice>
      : <Notice kind="info">Email is set up ({host}). If nothing arrives within a few minutes, check the spam folder and press <em>Send the link again</em> - any problem with the mail server is shown here.</Notice>
  }
  return (
    <Notice kind="warn">
      {error
        ? <>Sending through the mail server failed: {error} The message was saved on this computer instead.</>
        : <>No mail server is set up, so nothing can reach the inbox - the message was saved on the computer that runs RoadMind instead.</>}
      <br />Open the newest file in <code className="code-path">{outboxDir || 'backend/data/outbox'}</code>and click the link inside it.
      <br /><strong>To send real email</strong> (Gmail): copy <code>.env.example</code> to <code>.env</code>, put the Gmail address and an
      <em> App Password</em> in it and restart RoadMind. Steps are in the README under "Real email with Gmail".
    </Notice>
  )
}
