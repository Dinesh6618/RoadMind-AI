import { useSearchParams } from 'react-router-dom'
import AccountSettings from '../AccountSettings'
import Models from './Models'

/** Settings → Account Settings (change username, email, password, profile, log out) and System (models, formulas, disclaimers). */
export default function Settings() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'system' ? 'system' : 'account'
  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'account'} className={tab === 'account' ? 'on' : ''} onClick={() => setParams({})}>Account Settings</button>
        <button role="tab" aria-selected={tab === 'system'} className={tab === 'system' ? 'on' : ''} onClick={() => setParams({ tab: 'system' })}>System &amp; models</button>
      </div>
      {tab === 'account' ? <AccountSettings /> : <Models />}
    </>
  )
}
