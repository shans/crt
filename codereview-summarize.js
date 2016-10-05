var Other = "other";
var WaitingForReview = "waiting for review";
var WaitingForAuthor = "waiting for author";
var WaitingForBots = "waiting for bots";
var NotWaiting = "not waiting";


var ChangedReviewers = "changed reviewers";
var CQBitChecked = "CQ bit checked";
var CQBitUnchecked = "CQ bit unchecked";
var Comments = "Review comments";
var ResponseToComments = "Response to comments";
var Committed = "Committed";
var AutoGenerated = "automatic message";

function fastSummarize(data) {
  createDateDeltas(data);
  classifyMessageTypes(data);
  generateSummaries(data);
  extractComments(data);
  generateEffectiveReviewers(data);
  classifyWaitingType(data); 
  addNormalizedNames(data);
  computeAggregateWaitingTimes(data);
  return data;
}

function summarize(data) {
  return analyzeSentiment(fastSummarize(data)).then(() => data);
}

function createDateDeltas(data) {
  var d = Date.parse(data.created);

  // process dates into deltas
  for (var message of data.messages) {
    var e = Date.parse(message.date);
    message.delta = e - d;
    d = e;
  }
}

var messagePragmas = {
  "changed reviewers": ChangedReviewers,
  "The CQ bit was checked": CQBitChecked,
  "The CQ bit was unchecked": CQBitUnchecked,
  "Committed patchset": Committed
};

function classifyMessageTypes(data) {
  for (var message of data.messages) {
    if (message.auto_generated == true || message.sender == 'commit-bot@chromium.org') {
      // treat commit-bot messages as auto generated
      message.auto_generated = true;

      for (pragma in messagePragmas) {
        if (message.text.includes(pragma))
          message.type = messagePragmas[pragma];
      }
    } else if (message.text.includes(data.issue) && message.sender == data.owner_email) {
      message.type = ResponseToComments;
    } else {
      message.type = Comments;
    }
  }
}

function generateSummaries(data) {
  // summarize autogenerated messages, and messages from commit-bot
  for (var message of data.messages) {
    if (message.auto_generated) {
      if (/Description was changed/.exec(message.text))
        message.summary = "Description was changed";
      else if (/Dry run/.exec(message.text))
        message.summary = message.text;
      else if (/The patchset/.exec(message.text))
        message.summary = message.text;
      else if (message.sender == 'commit-bot@chromium.org')
        message.summary = message.text;
      else {
        switch(message.type) {
        case ChangedReviewers:
          message.summary = message.text.split('\n').slice(1).join('\n');
          break;
        case CQBitChecked:
        case CQBitUnchecked:
          message.summary = message.text;
          break;

        }
      }
    }
  }
}

function extractComments(data) {
  for (var message of data.messages) {
    if (message.type == ResponseToComments || message.type == Comments) {
      var _comments = message.text.split('\n\n');
      var comments = [];
      for (comment of _comments) {
        if (comment.startsWith(`https://codereview.chromium.org/${data.issue}/diff`))
          comments.push(comment);
        else if (comments.length > 0)
          comments[comments.length - 1] += '\n\n' + comment;
        else
          comments.push(comment);
      }
      _comments = comments;
      comments = [];
      for (comment of _comments) {
        if (comment.startsWith(`https://codereview.chromium.org/${data.issue}/diff`)) {
          comment = comment.split('\n').slice(2);
          if (comment.length == 0)
            continue;
          comment = comment.join('\n');
        }
        comments.push(comment);
      }
      message.comments = comments.filter(comment => comment.trim() != '');
    }
  }
}

function generateEffectiveReviewers(data) {
  // set effective reviewers
  var reviewers = [];
  var lgtm = [];
  for (var message of data.messages) {
    if (message.type == ChangedReviewers) {
      reviewers = reviewers.slice();
      var delta = message.summary.split(/[\s,]+/);
      var adding = true;
      for (var item of delta) {
        if (item == '+')
          adding = true;
        else if (item == '-')
          adding = false;
        else if (adding)
          reviewers.push(item)
        else
          reviewers.splice(reviewers.indexOf(item), 1);
      }
    }
    message.reviewers = reviewers;

    if (message.approval && !lgtm.includes(message.sender)) {
      lgtm = lgtm.slice();
      lgtm.push(message.sender);
      if (!reviewers.includes(message.sender)) {
        reviewers = reviewers.slice();
        reviewers.push(message.sender);
        message.reviewers = reviewers;
      }
    }
    message.lgtm = lgtm;

    message.all_lgtm = true;
    for (var reviewer of message.reviewers) {
      if (!lgtm.includes(reviewer))
        message.all_lgtm = false;
    }
    
  }
}

function classifyWaitingType(data) {
  // classify messages
  for (var i = 0; i < data.messages.length; i++) {
    var message = data.messages[i];

    if (message.reviewers.length == 0) {
      message.waitClass = Other;
      continue;
    }

    if (message.type == ChangedReviewers) {
      message.waitClass = WaitingForReview;
      continue;
    }

    if (!message.auto_generated && message.reviewers.includes(message.sender)) {
      message.waitClass = WaitingForAuthor;
      continue;
    }

    if (message.type == CQBitChecked) {
      if (message.all_lgtm)
        message.waitClass = WaitingForBots;
      else
        message.waitClass = data.messages[i - 1].waitClass;
      continue;
    } 

    if (message.type == CQBitUnchecked && message.all_lgtm) {
      message.waitClass = WaitingForAuthor;
      continue;
    }

    /*
     * The patch owner sent this message.
     * 
     * Look through subsequent messages that
     * are sent by the sender or are autogenerated.
     * If any of them are responses to review comments
     * then the sender isn't waiting.
     */

    // check returns true if the sender is still reviewing in the future.
    function check(idx) {
      if (idx >= data.messages.length) {
        return false;
      }
      var message = data.messages[idx];
      if (!((message.sender == data.owner_email) || message.auto_generated))
        return false;
      if (message.type == ResponseToComments) {
        i = idx - 1;
        return true;
      }
      var isReviewingInFuture = check(idx + 1);
      if (isReviewingInFuture)
        message.waitClass = WaitingForAuthor;
      return isReviewingInFuture;
    }

    if (message.sender == data.owner_email && !message.auto_generated) {
      if (check(i + 1))
        message.waitClass = WaitingForAuthor;
      else if (message.all_lgtm)
        message.waitClass = WaitingForAuthor;
      else
        message.waitClass = WaitingForReview;
      continue;
    }

    if (message.type == Committed) {
      message.waitClass = NotWaiting;
      var j = i - 1;
      while (j >= 0) {
        data.messages[j].waitClass = WaitingForBots;
        if (data.messages[j--].type == CQBitChecked)
          break;
      }
      continue;
    }

    if (message.auto_generated) {
      message.waitClass = data.messages[i - 1].waitClass;
      continue;
    }

    message.waitClass = "uuuuhhhhhhh....";

  }
}

function analyzeSentiment(data) {
  if (!window.analysisToken) {
    return Promise.resolve();
  }
  let promises = [];
  for (let message of data.messages) {
    if (!message.comments)
      continue;
    var request = {
      document:{
        type: 'PLAIN_TEXT',
        content: message.comments.join('\n'),
      },
      encodingType: 'UTF8',
    };
    promises.push(fetch('https://language.googleapis.com/v1beta1/documents:analyzeSentiment', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${analysisToken}`,
      },
    }).then(response => response.json()).then(json => message.analysis = json));
  }
  return Promise.all(promises);
}

function computeAggregateWaitingTimes(data) {
  var type = Other;
  data.waitingTimes = {};
  for (var message of data.messages) {
    if (data.waitingTimes[type] == undefined)
      data.waitingTimes[type] = 0;
    data.waitingTimes[type] += message.delta;
    type = message.waitClass;
  }
}

function addNormalizedNames(data) {
  let names = {
    [data.owner_email]: 'author',
    'commit-bot@chromium.org': 'commit-bot',
  };
  let reviewerCount = 0;
  let driveByCount = 0;
  let allReviewers = new Set([].concat(...data.messages.map(message => message.reviewers)));
  for (let reviewer of allReviewers) {
    names[reviewer] = `reviewer${++reviewerCount}`;
  }
  function normalize(name) {
    if (!(name in names)) {
      names[name] = `driveby${++driveByCount}`;
    }
    return names[name];
  }
  for (let message of data.messages) {
    message.normalizedSender = normalize(message.sender);
  }
}
