"""GitHub runner candidate. Standard library only, no SSH or database credentials."""
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlsplit

BASE = 'https://www.japean.com/'
ENDPOINT = BASE + 'jp-sitemap-refresh.php'
FILES = ('1_fr_0_sitemap.xml', 'sitemap-blog.xml')

SERVER_CODES = {
    'head_policy_requires_review': 'Canonical or robots policy changed; review the theme rules.',
    'seo_policy_unrecognized': 'Canonical or robots rules cannot be identified safely; review the theme.',
    'seo_policy_config_invalid': 'Versioned SEO policy fingerprint missing or invalid.',
    'route_policy_drift': 'Catalogue route policy changed; review before refreshing.',
    'cms_route_drift': 'CMS URL route changed; review before refreshing.',
    'shop_drift': 'Shop configuration changed; review before refreshing.',
    'inventory_truncated': 'Catalogue inventory below the safety minimum.',
    'preview_limit_review_required': 'Preview retention limit reached; review private state.',
    'backup_limit_review_required': 'Backup retention limit reached; review private state.',
    'large_delta_requires_review': 'Sitemap URL changes exceed the safety limit.',
    'aggregate_delta_limit': 'Combined changes exceed the safety limit.',
    'invalid_schedule': 'Blog publication schedule is not recognized.',
    'busy': 'Another refresh holds the lock.',
    'preview_expired': 'Preview expired; no automatic apply retry.',
    'preview_drift_or_replay': 'Sources changed after preview or request was replayed.',
    'source_drift': 'XML changed between preview and apply.',
    'concurrent_drift': 'A concurrent XML change was detected.',
    'failed_and_restored': 'Installation failed; original XML files restored.',
    'rollback_blocked_concurrent_writer': 'Rollback stopped to preserve another writer’s changes.',
    'rollback_source_drift': 'Rollback stopped because live XML changed.',
    'rollback_readback_failed': 'Rollback write could not be verified; inspect server.',
    'rollback_rename_failed': 'Rollback replacement failed; inspect server.',
    'backup_corrupt': 'Rollback backup did not match its expected fingerprint.',
    'atomic_same_filesystem_required': 'Staging is not on the same filesystem.',
    'stage_owner_mismatch': 'Staged XML ownership differs; inspect server.',
    'invalid_xml': 'Input XML is invalid.',
    'server_error': 'Server rejected the request; inspect private diagnostics.',
}


class RefreshFailure(ValueError):
    def __init__(self, phase, code, explanation):
        super().__init__(f'{phase}: {code} — {explanation}')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, payload=None, token=None):
    safe_url(url)
    headers = {'User-Agent': 'JapeanMonitor/1.0'}
    if token is not None:
        if url != ENDPOINT:
            raise ValueError('Token destination refused')
        headers.update(Authorization='Bearer ' + token, **{'Content-Type': 'application/json'})
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(2000001)
        if len(body) > 2000000:
            raise ValueError('Response limit')
        return response.code, dict(response.headers.items()), body


def safe_url(url):
    p = urlsplit(url)
    if (p.scheme != 'https' or p.netloc != 'www.japean.com' or p.query or p.fragment
            or p.username or not p.path.startswith('/') or '..' in p.path):
        raise ValueError('URL outside exact public scope')


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonicals, self.robots = [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'link' and 'canonical' in a.get('rel', '').lower().split():
            self.canonicals.append(a.get('href'))
        if tag == 'meta' and a.get('name', '').lower() in ('robots', 'googlebot', 'bingbot'):
            self.robots.append(a.get('content', ''))


def public_state(url, getter=fetch):
    safe_url(url)
    code, headers, body = getter(url)
    h = Head()
    if code == 200:
        h.feed(body.decode('utf-8', errors='replace'))
    robots = h.robots + [v for k, v in headers.items() if k.lower() == 'x-robots-tag']
    noindex = any(re.search(r'\b(?:noindex|none)\b', value, re.I) for value in robots)
    canonical = h.canonicals[0] if len(h.canonicals) == 1 else None
    return code, canonical, noindex


def validate_preview(p, getter=fetch):
    if p.get('status') != 'PREVIEW' or not re.fullmatch('[a-f0-9]{32}', p.get('run_id', '')) or not re.fullmatch('[a-f0-9]{64}', p.get('proof', '')):
        raise ValueError('Invalid preview')
    if set(p.get('hashes', {})) != set(FILES) or any(not re.fullmatch('[a-f0-9]{64}', v) for v in p['hashes'].values()):
        raise ValueError('Invalid hashes')
    added, removed = p.get('added'), p.get('removed')
    if not isinstance(added, list) or not isinstance(removed, list) or len(added) > 40 or len(removed) > 40:
        raise ValueError('Delta limit')
    if len(set(added + removed)) != len(added + removed):
        raise ValueError('Duplicate delta')
    for url in added:
        code, canonical, noindex = public_state(url, getter)
        if code != 200 or canonical != url or noindex:
            raise ValueError('New URL not publicly eligible')
        time.sleep(1)
    for url in removed:
        code, canonical, noindex = public_state(url, getter)
        if code not in (301, 302, 303, 307, 308, 404, 410) and not (code == 200 and (noindex or (canonical is not None and canonical != url))):
            raise ValueError('Removal needs manual review')
        time.sleep(1)


def verify_hashes(hashes, getter=fetch, sleeper=time.sleep, clock=time.monotonic):
    if set(hashes) != set(FILES):
        raise ValueError('Exact two-file verification required')
    deadline = clock() + 660
    while True:
        matches = []
        for name in FILES:
            code, _, body = getter(BASE + name)
            matches.append(code == 200 and hashlib.sha256(body).hexdigest() == hashes[name])
        if all(matches):
            return
        if clock() >= deadline:
            raise ValueError('Public XML not fully confirmed; no purge or rollback based only on cache')
        sleeper(30)


def action(payload, token):
    phase = 'apply' if payload['action'] == 'apply' else 'preview'
    try:
        code, headers, body = fetch(ENDPOINT, payload, token)
    except Exception:
        raise RefreshFailure(phase, 'endpoint_transport', 'Request did not complete; no POST retry.') from None
    if code == 503 and len(body) <= 1024 and any(k.lower() == 'content-type' and v.lower().startswith('application/json') for k,v in headers.items()):
        try:
            error = json.loads(body)
        except (ValueError, UnicodeError):
            error = None
        if isinstance(error, dict) and error.get('status') == 'STOPPED':
            tag = error.get('code')
            if isinstance(tag, str) and tag in SERVER_CODES:
                raise RefreshFailure(phase, tag, SERVER_CODES[tag])
    if code != 200:
        raise RefreshFailure(phase, f'http_{code}', 'Endpoint refused; no POST retry.')
    try:
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise ValueError()
        return parsed
    except (ValueError, UnicodeError):
        raise RefreshFailure(phase, 'invalid_response', 'Endpoint response is not recognized.') from None


def checked_public_hashes(hashes):
    try:
        verify_hashes(hashes)
    except Exception:
        raise RefreshFailure('public-xml', 'verification_failed', 'Both public XML hashes were not confirmed; inspect HTTP/cache without purging.') from None


def main():
    token = os.environ.get('JAPEAN_SITEMAP_TOKEN', '')
    if not re.fullmatch('[a-f0-9]{64}', token):
        raise RefreshFailure('config', 'token_missing', 'Dedicated GitHub secret missing or invalid.')
    preview = action({'action': 'preview'}, token)
    if preview.get('status') == 'UNCHANGED':
        checked_public_hashes(preview.get('hashes'))
        print('UNCHANGED_PUBLICLY_VERIFIED')
        return
    try:
        validate_preview(preview)
    except Exception:
        raise RefreshFailure('url-validation', 'preview_rejected', 'Preview or URL eligibility checks failed; no apply sent.') from None
    result = action({'action': 'apply', 'run_id': preview['run_id'], 'proof': preview['proof']}, token)
    if result.get('status') != 'APPLIED' or result.get('after') != preview['hashes']:
        raise RefreshFailure('apply', 'readback_unconfirmed', 'Application not confirmed; do not resend.')
    checked_public_hashes(preview['hashes'])
    print(json.dumps({'status': 'APPLIED_PUBLICLY_VERIFIED', 'added': len(preview['added']), 'removed': len(preview['removed'])}))


if __name__ == '__main__':
    try:
        main()
    except RefreshFailure as error:
        print('::error title=Sitemap refresh::' + str(error))
        raise SystemExit(1)
    except Exception:
        # Do not dump request headers, env, URL query strings or a traceback into CI logs.
        print('::error title=Sitemap refresh::internal_error — Inspect private diagnostics; no POST retry.')
        raise SystemExit(1)
