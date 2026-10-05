import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/** A small modal confirmation ("Are you sure you want to log out?"). Escape or a click outside cancels; focus starts on Cancel. */
export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel }) {
  const cancel = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    cancel.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.() }
  }, [onCancel])
  return createPortal(
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby={message ? 'dlg-msg' : undefined}>
        <h2 id="dlg-title">{title}</h2>
        {message && <p id="dlg-msg">{message}</p>}
        <div className="dlg-actions">
          <button type="button" className="btn" ref={cancel} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
