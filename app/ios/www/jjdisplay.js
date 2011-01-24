// ======================================================================
// Viewport class

function Viewport(options) {
    options = options || {};

    // Position
    this.x = options.x || 0;
    this.y = options.y || 0;

    // Size
    this.width  = options.width  || 1;
    this.height = options.height || 1;

    // Rotation: 0=up 1=90deg 2=180deg 3=270deg
    this.rotation = options.rotation || 0;
}

Viewport.prototype = {

    translate: function translate(x, y) {
	this.x += x;
	this.y += y;
    },

    scale: function scale(x, y, ox, oy) {
	this.x = (this.x - ox) * x + ox;
	this.y = (this.y - oy) * y + oy;
	this.width *= x;
	this.height *= y;
    },

    string: function string() {
	return ('' + this.x + ',' + this.y +
		' ' + this.width + 'x' + this.height +
		' (' + this.rotation + ')');
    },

    equals: function equals(other) {
	return (this.x == other.x && this.y == other.y &&
		this.width == other.width && this.height == other.height &&
		this.rotation == other.rotation);
    },

    isSideways: function isSideways() {
	return this.rotation == 1 || this.rotation == 3;
    }
};

// ======================================================================
// Display class

function Display() {
    Client(this);

    // Cache for speed
    this.imgElem = $('#img');
    this.cropElem = $('#crop');

    this.mode = "idle";	// idle|dragging|scaling|loading

    this.image = new Image();
    this.image.onload  = bind(this, this.onImageLoad);
    this.image.onerror = bind(this, this.onImageError);
    this.viewport = new Viewport();
    this.frozen = false; // Can we pan and zoom?

    this.firstMouseX = 0;
    this.firstMouseY = 0;
    this.lastTranslateX = 0;
    this.lastTranslateY = 0;
    this.lastScaleX = 1;
    this.lastScaleY = 1;

    this.viewportMsgScheduled = null;

    this.initDom();
    this.initSocket();
}

Display.prototype = new Client();

$.extend(Display.prototype, {

    initDom: function initDom() {
	$(window)
	    .resize   (bind(this, this.handleResize))
	    .keyup    (bind(this, this.handleKeyup))
	    .mousedown(bind(this, this.handleMousedown))
	    .mousemove(bind(this, this.handleMousemove))
	    .mouseup  (bind(this, this.handleMouseup));
	document.ontouchstart	= bind(this, this.handleTouchstart);
	document.ontouchmove	= bind(this, this.handleTouchmove);
	document.ontouchend	= bind(this, this.handleTouchend);
	document.ongesturestart = bind(this, this.handleGesturestart);
	document.ongesturechange= bind(this, this.handleGesturechange);
	document.ongestureend	= bind(this, this.handleGestureend);
    },

    getJumbotronName: function getJumbotronName() {
	var url = window.location.pathname;
	return url.substring(url.lastIndexOf('/')+1);
    },

    // ----------------------------------------------------------------------
    // Transforms

    transformImg: function transformImg() {
	// Cache for speed
	var round = Math.round;
	var vp = this.viewport;

	// Get doc size, swap if sideways
	var docWidth, docHeight;
	if (vp.isSideways()) {
	    docWidth  = $(window).height();
	    docHeight = $(window).width();
	}
	else {
	    docWidth  = $(window).width();
	    docHeight = $(window).height();
	}

	// Amount the image needs to be scaled
	var scaleX = docWidth  / vp.width;
	var scaleY = docHeight / vp.height;

	// Final image size
	if (! this.image.width) {
	    this.imgElem.removeAttr("width"); 
	    this.imgElem.removeAttr("height");
	    this.image.width  = this.imgElem.width();
	    this.image.height = this.imgElem.height(); 
	}
	var imgWidth  = round(this.image.width  * scaleX);
	var imgHeight = round(this.image.height * scaleY);

	// Margins to push the image into place
	var marginX = round(-vp.x * scaleX);
	var marginY = round(-vp.y * scaleY);

	// Handle crop and rotation (on the 'crop' div)
	var transformStr = ['rotate(0deg) translate(0%, 0%)',
			    'rotate(90deg) translate(0%, -100%)',
			    'rotate(180deg) translate(-100%, -100%)',
			    'rotate(270deg) translate(-100%, 0%)'][vp.rotation];
	this.cropElem.css({'width'  : docWidth,
			   'height' : docHeight,
			   '-webkit-transform': transformStr,
			   '-moz-transform'   : transformStr
			  });

	// Handle translation and scaling (on the 'img' div)
	this.imgElem.css({'margin-top'	: marginY + 'px',
			  'margin-left'	: marginX + 'px',
			  'width'	: imgWidth + 'px',
			  'height'	: imgHeight + 'px'
			 });
    },
    
    translateViewport: function translateViewport(x, y) {
	// For consistency with how scaling is done, store last values,
	// invert, and retranslate.
	var vp = this.viewport;

	// Get viewport size, swap if sideways
	var vpWidth = vp.width;
	var vpHeight = vp.height;
	if (vp.isSideways()) {
	    vpWidth = vp.height;
	    vpHeight = vp.width;
	}

	// Convert from window pixels to viewport pixels
	x *= vpWidth  / $(window).width();
	y *= vpHeight / $(window).height();

	// Calculate delta, flipping if rotated
	var deltaX = x - this.lastTranslateX;
	var deltaY = y - this.lastTranslateY;
	var delta = [[ deltaX,  deltaY],
		     [ deltaY, -deltaX],
		     [-deltaX, -deltaY],
		     [-deltaY,  deltaX]][vp.rotation];

	// Translate and schedule a message to the server
	vp.translate(delta[0], delta[1]);
	this.transformImg();
	this.scheduleViewportMsg();

	// Save for next time
	this.lastTranslateX = x;
	this.lastTranslateY = y;
    },

    // Scaling should occur relative to first mouse-down event (dragging back to
    // the first point should reset the scale). We store how much we scaled last
    // time, invert it, and scale what we want.
    scaleViewport: function scaleViewport(x, y, ox, oy) {
	var vp = this.viewport;

	// Convert origin from window pixels to viewport pixels
	ox = ox * vp.width  / $(window).width () + vp.x;
	oy = oy * vp.height / $(window).height() + vp.y;

	// Don't let scale get really small
	x = Math.max(x, 0.1);
	y = Math.max(y, 0.1);

	// Calculate delta
	var deltaX = x / this.lastScaleX;
	var deltaY = y / this.lastScaleY;

	// Scale and schedule a message to the server
	vp.scale(deltaX, deltaY, ox, oy);
	this.transformImg();
	this.scheduleViewportMsg();

	// Save for next time
	this.lastScaleX = x;
	this.lastScaleY = y;
    },

    // ----------------------------------------------------------------------
    // Window events

    handleResize: function handleResize() {
	// Update css, update image transform, and notify the server
	$('#finalcrop').css({width : $(window).width(),
			     height: $(window).height()}); 
	this.transformImg();
	this.sendSizeMsg();
    },

    // ----------------------------------------------------------------------
    // Key events

    handleKeyup: function handleKeyup(event) {
	switch (event.which) {
	case 86: // 'v'
	    alert(this.viewport.string());
	    break;
	default:
	    break;
	}
    },

    // ----------------------------------------------------------------------
    // Mouse events

    handleMousedown: function handleMousedown(event) {
	event.preventDefault();
	if (this.frozen)
	    return;

	this.firstMouseX = event.pageX;
	this.firstMouseY = event.pageY;
	this.mode = event.shiftKey ? "scaling" : "dragging";
	if (event.shiftKey) {
	    this.mode = "scaling";
	    this.lastScaleX = 1;
	    this.lastScaleY = 1;
	}
	else {
	    this.mode = "dragging";
	    this.lastTranslateX = 0;
	    this.lastTranslateY = 0;
	}
    },

    handleMousemove: function handleMousemove(event) {
	var deltaX = event.pageX - this.firstMouseX;
	var deltaY = event.pageY - this.firstMouseY;
	if (this.mode == "scaling") {
	    // Normalize mouse movements so they're in the range (-1,1)
	    // and allow only uniform scales.
	    var wsize = Math.max($(window).width(), $(window).height());
	    var scale = 1.0 + (deltaY - deltaX) / wsize;
	    this.scaleViewport(scale, scale, this.firstMouseX, this.firstMouseY);
	}
	else if (this.mode == "dragging") {
	    this.translateViewport(-deltaX, -deltaY);
	}
    },

    handleMouseup: function handleMouseup(event) {
	event.preventDefault();
	if (this.mode == "scaling" || this.mode == "dragging")
	    this.mode = "idle";
    },

    // ----------------------------------------------------------------------
    // Touch events

    handleTouchstart: function handleTouchstart(event) {
	event.preventDefault();
	if (this.frozen)
	    return;

	var touch = event.changedTouches[0];
	this.firstMouseX = touch.pageX;
	this.firstMouseY = touch.pageY;

	// Only deal with one finger
	if (event.changedTouches.length == 1) {
	    this.mode = "dragging";
	    this.lastTranslateX = 0;
	    this.lastTranslateY = 0;
	}
    },

    handleTouchmove: function handleTouchmove(event) {
	if (this.mode == "dragging") {
	    event.preventDefault();
	    var touch = event.changedTouches[0];
	    var deltaX = touch.pageX - this.firstMouseX;
	    var deltaY = touch.pageY - this.firstMouseY;
	    this.translateViewport(-deltaX, -deltaY);
	}
    },

    handleTouchend: function handleTouchend(event) {
	event.preventDefault();
	if (this.mode == "scaling" || this.mode == "dragging")
	    this.mode = "idle";
    },

    // ----------------------------------------------------------------------
    // Gesture events

    handleGesturestart: function handleGesturestart(event) {
	event.preventDefault();
	if (this.frozen)
	    return;

	this.mode = "scaling";
	this.lastScaleX = 1;
	this.lastScaleY = 1;
    },

    handleGesturechange: function handleGesturechange(event) {
	event.preventDefault();
	this.scaleViewport(1.0 / event.scale, 1.0 / event.scale,
			    this.firstMouseX, this.firstMouseY);
    },

    handleGestureend: function handleGestureend(event) {
	event.preventDefault();
	this.scaleViewport(1.0 / event.scale, 1.0 / event.scale,
			    this.firstMouseX, this.firstMouseY);
	if (this.mode == "scaling" || this.mode == "dragging")
	    this.mode = "idle";
    },

    // ----------------------------------------------------------------------
    // Communication 

    sendInitMsg: function sendInitMsg() {
	var id = $.cookie("jjid");
	var name = this.getJumbotronName();
	var docWidth  = $(window).width();
	var docHeight = $(window).height();
	this.sendMsg("connect", {jjid: id, jjname: name,
				 width: docWidth, height: docHeight});
	this.sendSizeMsg();
    },

    sendViewportMsg: function sendViewportMsg() {
	this.viewportMsgScheduled = null;
	var vp = this.viewport;
	this.sendMsg('viewport', {
	    x: vp.x, y: vp.y, width: vp.width, height: vp.height });
    },

    scheduleViewportMsg: function scheduleViewportMsg() {
	// Avoid overloading the server by restricting msgs/sec
	if (! this.viewportMsgScheduled)
	    this.viewportMsgScheduled = setTimeout(
		bind(this, this.sendViewportMsg), 100);
    },
    
    sendSizeMsg: function sendSizeMsg() {
	var docWidth  = $(window).width();
	var docHeight = $(window).height();
	this.sendMsg("size", {width: docWidth, height: docHeight});
    },

    onImageLoad: function onImageLoad() {
	this.mode = "idle";
	this.imgElem.attr('src', this.image.src);
	this.transformImg();
    },

    onImageError: function onImageError() {
	this.mode = "idle";
	this.sendErrorMsg("Can't load image", this.image.src);
    },

    msgHandlers : {

	load: function load(args) {
	    var image = this.image;
	    if (this.image.src != args.src) {
		this.mode = "loading";
		this.frozen = args.frozen;
		this.viewport = new Viewport(args.viewport);
		this.image.src = args.src;
		if (this.image.complete)
		    this.onImageLoad();
	    }
	    else {
		// Pass to viewport message handler
		this.msgHandlers.viewport.call(this, args.viewport);
	    }
	},

	viewport: function viewport(args) {
	    if (! this.viewport.equals(args)) {
		this.viewport = new Viewport(args);
		// Ignore changes while interacting or loading an image
		if (this.mode == "idle" && ! this.viewportMsgScheduled)
		    this.transformImg();
	    }
	},

	errorMsg: function error(args) {
	    console.log("ERROR from server:", args);
	}
    },
});

// ----------------------------------------------------------------------

$(function() {
    var display = new Display();
});