require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const url = require('url');
const snoowrap = require('snoowrap');

// Telegram Bot stuff
const { TOKEN, VERCEL_URL } = process.env;
const SERVER_URL = `https://${VERCEL_URL}`;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const URI = `/webhook/${TOKEN}`;
const WEBHOOK_URL = SERVER_URL + URI;

// Reddit API stuff
const { USER_AGENT, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } = process.env;
let ACCESS_TOKEN = null;
// Reddit snoowrap object
let r = null;

const app = express();
app.use(bodyParser.json());

// Initialize stuff
const init = async () => {
    // Avoid initializing variables in listen function when using Serverless functions

    // Set Telegram Webhook
    const res = await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_URL}`);
    console.log(res.data);
}

// Database alternative
let dataObject = {};

app.get('/', async (req, res) => {
    res.send({
        token: TOKEN,
        vercel_url: VERCEL_URL,
        webhook_url: WEBHOOK_URL
    })
})

// Receive messages
app.post(URI, async (req, res) => {
    console.log(req.body);

    if (!req.body.message || !req.body.message.text) return res.send();

    // Get access token
    if (!ACCESS_TOKEN) ACCESS_TOKEN = await getAccessToken();

    // Instanciate snoowrap object
    if (!r) {
        r = new snoowrap({
            userAgent: USER_AGENT,
            accessToken: ACCESS_TOKEN
        })
    };

    const chatId = req.body.message.chat.id;
    const messageText = req.body.message.text;

    let response_message = '';

    // Check access_token validity
    if (!isValidToken(ACCESS_TOKEN)) {
        ACCESS_TOKEN = await getAccessToken();
    }

    // Data object
    // First time
    if (!dataObject[chatId]) {
        dataObject[chatId] = {};
        dataObject[chatId]['last_cmd'] = '/start';
        dataObject[chatId]['last_posts'] = [];
    }


    // Chack if message is a bot command
    if (isBotCommand(req.body.message)) {
        dataObject[chatId]['last_cmd'] = messageText;

        switch (messageText) {
            case '/posts':
                // Reset lasts_posts array
                dataObject[chatId]['last_posts'] = [];

                let posts = await getPosts();

                // Format posts list
                for (let i = 0; i < posts.length; i++) {
                    let post = `<a href="${posts[i].url}">${posts[i].title}</a>`
                    response_message += `${i + 1} - ${post}\n\n`;
                    dataObject[chatId]['last_posts'].push(posts[i].url);
                }

                response_message += '\nSend post number to get details.'
                break;

            case '/details':
                response_message = 'Please enter post URL.';
                break;

            case '/start':
                response_message = '';
                break;

            default:
                response_message = 'Please enter a valid bot command.'
                break;
        }
    }
    else {
        if (dataObject[chatId]['last_cmd'] === '/posts') {
            // Check if message received is a valid number
            if (isNaN(messageText) || parseInt(messageText) < 0 || parseInt(messageText) > dataObject[chatId]['last_posts'].length) {
                response_message = 'Please enter a valid number.'
            }
            else {
                const number = parseInt(messageText);
                const post_url = dataObject[chatId]['last_posts'][number - 1];
                const post = await getPostDetails(post_url);
                response_message = formatPostDetails(post);
            }
        }
        else if (dataObject[chatId]['last_cmd'] === '/details') {
            // isValidURL() is an async funciton
            const isValid = await isValidURL(messageText);
            if (isValid) {
                let post = await getPostDetails(messageText);
                response_message = formatPostDetails(post);
            }
            else {
                response_message = 'Please enter a valid post URL.'
            }
        }
    }

    // Respond to user
    if (response_message != '') {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: response_message,
            parse_mode: 'html',
            disable_web_page_preview: true
        })
    }

    // Respond to Telegram server
    return res.send();
})


async function getAccessToken() {
    // Basic Auth credentials
    // Authorization : Basic username:password ==> encoded in base64
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64');

    const params = {
        'grant_type': 'refresh_token',
        'refresh_token': REFRESH_TOKEN
    }

    // Convert JSON to "appropriate" (Reddit) Content-Type
    const data = new url.URLSearchParams(params);

    const res = await axios.post('https://www.reddit.com/api/v1/access_token', data.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`
        }
    })

    console.log(res.data.access_token);

    return res.data.access_token;
}


async function isValidToken(token) {
    let res = await axios.get('https://oauth.reddit.com/api/v1/me', {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    // response is JSON not HTML ("id" is a key in the JSON object)
    return res.data.id ? true : false;
}


function isBotCommand(msg) {
    if (msg.text.startsWith('/') && msg.entities) {
        for (let entity of msg.entities) {
            return entity.type === "bot_command";
        }
    }
}


async function getPosts(lmt = 50) {
    let limit = lmt;

    let submissions = await r.getSubreddit('forhire').getNew({ limit: limit });
    submissions = submissions.filter(sub => !['for', 'filled'].some(el => sub['link_flair_text'] ? sub['link_flair_text'].toLowerCase().includes(el) : false) && !sub['over_18']).map(sub => {
        // remove flair from title
        let sub_title = sub.title;
        if (sub_title.match(/\[(.*?)]/gm) && sub_title.match(/\[(.*?)]/gm).length) {
            sub_title.match(/\[(.*?)]/gm).forEach(res => { if (res.length < 11) sub_title = sub_title.replace(res, '').trim() });
        }

        return {
            title: sub_title,
            url: sub['url']
        }
    });

    return submissions;
}


async function getPostDetails(post_url) {
    let oauth_url = post_url.replace('https://www.reddit.com', 'https://oauth.reddit.com');
    // axios token bearer
    let res = await axios.get(oauth_url, {
        headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`
        }
    });

    let post = res.data[0].data.children[0].data;

    // remove flair from title
    let post_title = post.title;
    if (post_title.match(/\[(.*?)]/gm) && post_title.match(/\[(.*?)]/gm).length) {
        post_title.match(/\[(.*?)]/gm).forEach(res => { if (res.length < 11) post_title = post_title.replace(res, '').trim() });
    }

    return {
        title: post_title,
        flair: post['link_flair_text'],
        ups: post['ups'],
        downs: post['downs'],
        author: post['author'],
        comments: post['num_comments'],
        url: post['url'],
        created: secondsToDate(post['created_utc'])
    }
}


function formatPostDetails(post) {
    const details =
        '- <b>Title :</b> ' + post['title'] +
        '\n\n- <b>Flair :</b> ' + post['flair'] +
        '\n\n- <b>Upvotes :</b> ' + post['ups'] +
        '\n\n- <b>Downvotes :</b> ' + post['downs'] +
        '\n\n- <b>Author :</b> ' + post['author'] +
        '\n\n- <b>Comments :</b> ' + post['comments'] +
        '\n\n- <b>Date :</b> ' + post['created'];

    return details;
}


async function isValidURL(url) {
    if (url.startsWith('https://www.reddit.com/r/forhire/comments/')) {
        let oauth_url = url.replace('https://www.reddit.com', 'https://oauth.reddit.com');
        let res = await axios.get(oauth_url, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });
        if (res.status === 200) return true;
    }
    return false;
}


function secondsToDate(utcSeconds) {
    var d = new Date(0);
    d.setUTCSeconds(utcSeconds);
    return d.toUTCString();
}


app.listen(process.env.PORT || 5000, async () => {
    console.log('App is running on port', process.env.PORT || 5000);
    await init();
})