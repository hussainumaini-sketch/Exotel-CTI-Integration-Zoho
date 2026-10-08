// The Exotel phone, docked at the bottom right of the page. It opens as
// one line; an incoming call opens it with the caller. Desktop only: the
// Zoho phone app calls through the Call button instead.
var ua = '';
try { ua = String(navigator.userAgent || ''); } catch (e) { ua = ''; }
if (!/Android|iPhone|iPad|iPod|Mobile|ZohoCRM/i.test(ua)) {
  var cfg = { header: '', close_icon: false, close_on_escape: false, animation_type: 1, height: '48px', width: '400px', bottom: '36px', right: '16px' };
  var rid = '';
  try { rid = String($Page.record_id || ''); } catch (e) { rid = ''; }
  var fly = null;
  try { fly = ZDK.Client.getFlyout('exotel_dock'); } catch (e) { fly = null; }
  try {
    if (!fly) fly = ZDK.Client.createFlyout('exotel_dock', cfg);
    fly.open({ api_name: 'Exotel_CTI', type: 'widget' }, { host: 'dock', module: 'Accounts', recordId: rid });
  } catch (e) {
    log('Exotel dock: ' + (e && e.message));
  }
}
