import webapp2
import json
from google.appengine.api import urlfetch
from google.appengine.ext import ndb

class Issue(ndb.Model):
  json = ndb.TextProperty(compressed=True)
  analysedJson = ndb.TextProperty(compressed=True)
  sentimentAnalysed = ndb.BooleanProperty(default=False)

class ApiProxy(webapp2.RequestHandler):
  def get(self, issueNumber):
    self.response.headers.add_header("Access-Control-Allow-Origin", "*")

    issue = Issue.get_by_id(issueNumber)
    if issue is None:
      result = urlfetch.fetch(url='http://codereview.chromium.org/api/' + issueNumber + '?messages=True').content
      parsedResult = self.attachPatchsets(issueNumber, json.loads(result))
      if parsedResult['closed']:
        parsedResult['serverNeedsAnalysis'] = True
        result = json.dumps(parsedResult)
        issue = Issue(id=issueNumber, json=result)
        issue.put()
      result = json.dumps(parsedResult)
    else: 
      result = issue.json

    if issue is not None:
      self.response.headers['cache-control'] = 'max-age=315569000' 

    self.response.write(result)

  def attachPatchsets(self, issueNumber, parsedResult):
    parsedResult['patchset_data'] = [];
    rpcs = []
    for patch in parsedResult['patchsets']:
      rpc = urlfetch.create_rpc()
      rpc.callback = (lambda rpc: (lambda: parsedResult['patchset_data'].append(json.loads(rpc.get_result().content))))(rpc)
      urlfetch.make_fetch_call(rpc, 'http://codereview.chromium.org/api/' + issueNumber + '/' + str(patch))
      rpcs.append(rpc)
    
    for rpc in rpcs:
      rpc.wait()
    return parsedResult

class PrivateApiProxy(webapp2.RequestHandler):
  def post(self, issueNumber):
    issue = ndb.Key(Issue, issueNumber).get()
    if issue is None:
      self.response.set_status(400)
      return
    issue.analysedJson = self.request.body
    parsedJson = json.loads(issue.json)
    parsedJson['serverNeedsAnalysis'] = False
    issue.json = json.dumps(parsedJson)
    issue.put()
    self.response.set_status(200)

class SearchProxy(webapp2.RequestHandler):
  def get(self):
    self.response.headers.add_header("Access-Control-Allow-Origin", "*")

    if not (self.request.get('keys_only') == "True"):
      self.response.set_status(400)
      return

    result = urlfetch.fetch(url='http://codereview.chromium.org/search?' + self.request.query_string).content
    self.response.write(result)

app = webapp2.WSGIApplication([
  webapp2.Route(r'/api/<issueNumber>', handler=ApiProxy),
  webapp2.Route(r'/privateApi/<issueNumber>', handler=PrivateApiProxy),
  webapp2.Route(r'/search', handler=SearchProxy),
], debug=True)
