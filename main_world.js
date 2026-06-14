(function() {
  try {
    const data = window.ytInitialPlayerResponse;
    let isLive = false;
    let isMatch = false;
    let videoId = null;

    if (data && data.videoDetails) {
      isLive = (data.videoDetails.isLiveContent === true);
      videoId = data.videoDetails.videoId;
      isMatch = true; // We'll let the content script verify the ID match
    }
    
    window.postMessage({ 
      type: 'YtPosSaver_LiveInfo_Response', 
      isLive: isLive, 
      videoId: videoId,
      debug: 'Success' 
    }, '*');
  } catch(e) {
    window.postMessage({ 
      type: 'YtPosSaver_LiveInfo_Response', 
      error: true, 
      message: e.toString() 
    }, '*');
  }
})();
