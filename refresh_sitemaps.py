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
    code, _, body = fetch(ENDPOINT, payload, token)
    if code != 200:
        raise ValueError('Endpoint refused; no POST retry')
    return json.loads(body)


def main():
    token = os.environ.get('JAPEAN_SITEMAP_TOKEN', '')
    if not re.fullmatch('[a-f0-9]{64}', token):
        raise ValueError('Dedicated token not configured')
    preview = action({'action': 'preview'}, token)
    if preview.get('status') == 'UNCHANGED':
        verify_hashes(preview['hashes'])
        print('UNCHANGED_PUBLICLY_VERIFIED')
        return
    validate_preview(preview)
    result = action({'action': 'apply', 'run_id': preview['run_id'], 'proof': preview['proof']}, token)
    if result.get('status') != 'APPLIED' or result.get('after') != preview['hashes']:
        raise ValueError('Application not confirmed; do not resend')
    verify_hashes(preview['hashes'])
    print(json.dumps({'status': 'APPLIED_PUBLICLY_VERIFIED', 'added': len(preview['added']), 'removed': len(preview['removed'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not dump request headers, env, URL query strings or a traceback into CI logs.
        print('STOPPED: refresh or public verification failed; inspect aggregate server/CI state before intervention.')
        raise SystemExit(1)
