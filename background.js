var db = openDatabase('mhdb', '1.0', 'Mostly Harmless Database', 5 * 1024 * 1024);
var cacheTime;
var over18;
var commentsMatchPattern = /https?:\/\/www\.reddit\.com(\/r\/(.+?))?\/comments\/(.+?)\/.*/;
init();

function init() {
	setBadgeDefaults();
	chrome.tabs.onUpdated.addListener(listenToTabs);
	if(window.localStorage.getItem('installed') !== 'true') {
		installDefaults();
	}
	db.transaction(function(tx){
		// Load preferences
		tx.executeSql('SELECT * FROM prefs WHERE pref=?', ['cacheTime'], function(tx, results) {
			cacheTime = results.rows.item(0).choice;
		});
		tx.executeSql('SELECT * FROM prefs WHERE pref=?', ['over18'], function(tx, results) {
			over18 = results.rows.item(0).choice;
		});
		
		// Clear cache and post data
		tx.executeSql('DELETE FROM cache');
		tx.executeSql('DELETE FROM posts');
	});
}

function installDefaults(tx) {
	window.localStorage.setItem('installed','true');
	db.transaction(function(tx) {
		tx.executeSql('CREATE TABLE IF NOT EXISTS cache (pageUrl unique, cacheTime, howManyPosts)');
		tx.executeSql('CREATE TABLE IF NOT EXISTS posts (id unique, name, likes, domain, subreddit, author, score, over_18, hidden, thumbnail, downs, permalink, created_utc, url, title, num_comments, ups, modhash)')
		tx.executeSql('CREATE TABLE IF NOT EXISTS prefs (pref unique, choice)');
		tx.executeSql('INSERT INTO prefs (pref, choice) VALUES (?, ?)', ['cacheTime','1']);
		tx.executeSql('INSERT INTO prefs (pref, choice) VALUES (?, ?)', ['over18','false']);
	});
}

function setBadgeDefaults(tabId) {
	chrome.browserAction.setBadgeBackgroundColor({
		color: [192,192,192,255] //r,g,b,a
	});
	chrome.browserAction.onClicked.removeListener(submitToReddit);
	if(tabId) {
		chrome.browserAction.setBadgeText({
			text: '?',
			tabId: tabId
		});
		chrome.browserAction.setTitle({
			title: 'Refresh the page to load data.',
			tabId: tabId
		});
	} else {
		chrome.browserAction.setBadgeText({
			text: '?',
		});
		chrome.browserAction.setTitle({
			title: 'Refresh the page to load data.'
		});
	}
}

function listenToTabs(tabId,changeInfo,tab){
	if(changeInfo.status === 'loading') {
		//If the user is at /comments instead of /r/subreddit/comments, redirect them.
		if(commentsMatchPattern.test(tab.url) && !(/https?:\/\/www\.reddit\.com\/r\/(.+?)\/comments\/(.+?)\/.*/.test(tab.url))) {
			chrome.tabs.update(tabId,{url:'http://redd.it/' + tab.url.match(commentsMatchPattern)[3]});	
		} else {
			grabData(tab.url,tabId);
		}
	}
}

function grabData(url,tabId) {
	// If the URL hasn't been cached recently, fetch it from the API.
	db.transaction(function(tx) {
		tx.executeSql('SELECT * FROM cache WHERE pageUrl=?', [url], function(tx, results) {
			var cache = results.rows;
			var isCommentsPage = commentsMatchPattern.test(url);
			if(cache.length === 0 || -(cache.item(0).cacheTime - epoch()) > 60  * cacheTime ) { // cacheTime in minutes
				console.log('Loading from reddit api...');
				var reqUrl = new String();
				if(isCommentsPage) {
					var matches = url.match(commentsMatchPattern);
					reqUrl = 'http://www.reddit.com/by_id/t3_' + matches[3] + '.json';
				} else {
					reqUrl = 'http://www.reddit.com/api/info.json?url=' + encodeURI(url);
				}
				var api = new XMLHttpRequest();
				api.open('GET',reqUrl,false);
				api.send(null);
				if(api.status !== 200) {
					console.error('Error loading API.\nURL: ' + reqUrl + '\nStatus: ' + api.status);
					console.log(api);
					setBadgeDefaults(tabId);
				}
				api.onload = cacheData(JSON.parse(api.responseText),url,tabId,isCommentsPage);
			} else {
				console.log('Loading from cache...');
				preparePopup(url,tabId);
			}
		});
	});
}

function epoch() {
	return Math.floor(new Date().getTime()/1000);
}

function cacheData(response,pageUrl,tabId,isCommentsPage) {
	// add response to cache to reduce API calls
	if(response.data.children.length === 0) {
		db.transaction(function(tx) {
			tx.executeSql('INSERT OR REPLACE INTO cache (pageUrl, cacheTime, howManyPosts) VALUES (?, ?, ?)',[pageUrl, epoch(), '0',]);
		});
	} else {
		db.transaction(function(tx) {
			for(var i = 0; i < response.data.children.length; i++) {
				var data = response.data.children[i].data;
				var insertUrl = isCommentsPage ? 'http://www.reddit.com' + data.permalink : data.url;
				var insertNum = isCommentsPage ? '...' : response.data.children.length;
				tx.executeSql(
					'INSERT OR REPLACE INTO posts' +
					'(id, name, likes, domain, subreddit, author, score, over_18, hidden, thumbnail, downs, permalink, created_utc, url, title, num_comments, ups, modhash)' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
					[data.id, data.name, data.likes, data.domain, data.subreddit, data.author, data.score, data.over_18, data.hidden, data.thumbnail, data.downs, data.permalink, data.created_utc, insertUrl, data.title, data.num_comments, data.ups, response.data.modhash],
					function(tx) {
						tx.executeSql('INSERT OR REPLACE INTO cache (pageUrl, cacheTime, howManyPosts) VALUES (?, ?, ?)',[pageUrl, epoch(), insertNum]);
					});
			}
		});
	}
	preparePopup(pageUrl,tabId);
}

function preparePopup(url,tabId) {
	// counts submissions and prepare the browserAction button appropriately
	var numberOfSubmissions;
	db.transaction(function(tx){
		tx.executeSql('SELECT * FROM cache WHERE pageUrl=?', [url], function(tx, results) {
			numberOfSubmissions = results.rows.item(0).howManyPosts;
			if(numberOfSubmissions > 0) {
				chrome.browserAction.setTitle({
					title: 'This page has been submitted to reddit ' + numberOfSubmissions + ' times.',
					tabId: tabId
				});
				chrome.browserAction.setBadgeText({
					text: numberOfSubmissions.toString(),
					tabId: tabId
				});
				chrome.browserAction.setPopup({
					popup: 'popup.html',
					tabId: tabId
				});
				chrome.browserAction.setBadgeBackgroundColor({
					color: [255,69,0,255], //r,g,b,a,
					tabId: tabId
				});
				chrome.browserAction.onClicked.removeListener(submitToReddit);
			} else if(numberOfSubmissions === '...') {
				chrome.browserAction.setTitle({
					title: 'You are currently viewing the comments for this page.',
					tabId: tabId
				});
				chrome.browserAction.setBadgeText({
					text: numberOfSubmissions,
					tabId: tabId
				});
				chrome.browserAction.setPopup({
					popup: 'popup.html',
					tabId: tabId
				});
				chrome.browserAction.setBadgeBackgroundColor({
					color: [255,69,0,255], //r,g,b,a,
					tabId: tabId
				});
				chrome.browserAction.onClicked.removeListener(submitToReddit);
			} else {
				chrome.browserAction.setTitle({
					title: 'Submit this page to reddit',
					tabId: tabId
				});
				chrome.browserAction.setBadgeText({
					text: '',
					tabId: tabId
				});
				chrome.browserAction.setPopup({
					popup: '',
					tabId: tabId
				});
				chrome.browserAction.onClicked.removeListener(submitToReddit);
				chrome.browserAction.onClicked.addListener(submitToReddit);
			}
		});
	});
}

function submitToReddit(tab){
	chrome.tabs.create({
		url: 'http://www.reddit.com/submit?url=' + encodeURI(tab.url)
	});
}