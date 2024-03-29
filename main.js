console.log("Loading Main")

var finalBlob = null;

// Startup
$(function() {
    // Handle "Process"
    $("#file-form").submit(function(e) {
        e.preventDefault();

        if ($("#file")[0].files[0])
            loadFileFromForm();
    });

});

var loadFileFromForm = function() {
    // Get file
    const file = $("#file")[0].files[0];
    console.log(file);

    updateMessage('Processing...');

    // Create Reader
    var fr = new FileReader();

    // Set Reader's OnLoad
    fr.onload = function(){
        if (file.type == "text/html") {
            processFile(fr.result);
        }
        else {
            const blob = new Blob([fr.result], {type: file.type});
            getHTMLFromBlobAndProcess(blob);
        }
    }

    if (file.type == "text/html") {
        fr.readAsText(file);
    }
    else {
        // TODO: Only elif ZIP, otherwise err
        fr.readAsArrayBuffer(file);
    }
};

var getHTMLFromBlobAndProcess = async function(blob) {
    // Read Blob
    const reader = new zip.ZipReader(new zip.BlobReader(blob));

    // Get entries
    const entries = await reader.getEntries();
    console.log(entries);
    if (entries.length) {
        // Get HTML file from entries
        var html = entries.filter(obj => {
            return obj.filename.endsWith(".html");
        });

        // Get data in HTML file
        const text = await html[0].getData( new zip.TextWriter(), { onprogress: (index, max) => {} });

        // Get images
        var imageList = entries.filter(obj => {
            return obj.filename.includes("images");
        });

        // Get image blobs
        var imgs = [];
        for (let i = 0; i < imageList.length; i++) {
            const img = imageList[i];
            imgs.push({
                filename: img.filename, 
                content: await img.getData( new zip.BlobWriter(), { onprogress: (index, max) => {} })
            });
        };
        
        // Send to be processed
        processFile(text, imgs);
    }

    // close the ZipReader
    await reader.close();
}

var processFile = function(file, imgs = null) {
    console.log("=================================")
    console.log("Begin Processing File")
    console.log("=================================")
    // console.log(file);
    
    var turndownService = new TurndownService()

    var parser = new DOMParser();
    var doc = parser.parseFromString(file, 'text/html');
    
    console.log('Got document:', doc);
    
    // Get settings
    var settings = getSettings(doc);
    // settings.exclude : str[]
    //      excludes section. str is id of section(s) to be excluded.
    // settings.index : str
    //      "main page" -> index.md

    // Fix links
    const linkLUT = {};
    const h1s = doc.getElementsByTagName("h1");
    for (let i = 0; i < h1s.length; i++) {
        const e = h1s[i];
        linkLUT[e.id] = e.id;
    }

    var linksDone = false;
    var linksStartElement = null;
    while (!linksDone) {
        var currentSection = findUntilNext(doc, linksStartElement);
        
        var sectionID = linksStartElement == null ? 'index' : linksStartElement.id;

        const lowerHeadings = currentSection.section.querySelectorAll("h2, h3, h4, h5, h6");
        for (let i = 0; i < lowerHeadings.length; i++) {
            const e = lowerHeadings[i];
            // This is mostly a guess at the actual regex, but I think it'll work? mostly? 
            // see: https://github.com/jekyll/jekyll/blob/6855200ebda6c0e33f487da69e4e02ec3d8286b7/lib/jekyll/readers/data_reader.rb#L74
            linkLUT[e.id] = sectionID + "#" + 
                e.querySelector('span').textContent.trim().replaceAll(/[^\w\s-]+|(?<=^|\b\s)\s+(?=$|\s?\b)/g, "").replaceAll(/\s/g, '-').toLowerCase(); 
        };

        linksStartElement = currentSection.nextStartingNode;

        if (!currentSection.nextStartingNode){
            linksDone=true;
        };
    };

    // console.log('Link LUT:', linkLUT);

    const allLinks = Array.from(doc.getElementsByTagName("a"));
    for (let i = 0; i < allLinks.length; i++) {
        const link = allLinks[i];
        if (!link.getAttribute('href')){
            // pass
        }
        else if (Object.keys(linkLUT).includes(link.getAttribute('href').replace('#', ''))){
            link.setAttribute('href', linkLUT[link.getAttribute('href').replace('#', '')]);
        }
    }

    // Fix lists
    // First, convert all ol to ul
    var allOl = doc.getElementsByTagName('ol');
    // idc abt efficent algs and tree traversal this works for me
    // if we were here for efficency i'd be writing this whole program differently (or not at all)
    // don't judge me
    while (doc.getElementsByTagName('ol').length > 0) {
        for (let i = 0; i < allOl.length; i++) {
            const e = allOl[i];
            var d = doc.createElement('ul');
            d.innerHTML = e.innerHTML;
            d.classList = e.classList;
            e.parentNode.replaceChild(d, e);
        };
    }

    var lists = getAllLists(doc);
    var listOfListIds = getListIds(lists);
    console.log(listOfListIds);
    for (let i = 0; i < listOfListIds.length; i++) {
        // get a full list
        const list = lists.filter(l => l.id == listOfListIds[i]);

        const listHead = list[0];
        // For a single list, iterate and re-order.
        for (let j = 1 /* Skip list head */; j < list.length; j++) {
            const ul = list[j];
            if (ul.level == 0) { 
                appendAllChildren(listHead.element, [...ul.element.children]); // not a fan of side-effect functions but i'm gonna have to make do and die mad, im too deep. we love the sunk cost fallacy :D
                ul.element.remove();
            } else {
                appendToLevel(listHead.element, ul.element, ul.level)
            }
        };

    };
    console.warn(lists);

    console.log('Document after all changes:', doc);
    
    // Set up array of objects. {section, text}
    var mdStore = [];
    // Find all h1's and build the actual markdown pages
    var done = false;
    var startElement = null;
    while (!done) {
        var currentSection = findUntilNext(doc, startElement);

        var subsectionLinks = createSubsectionLinks(currentSection.section.body, linkLUT);

        console.log(subsectionLinks);
        
        var markdown = turndownService.turndown(currentSection.section);
        let headersPageName = "headers-" + sectionID;
        var sectionID = startElement == null ? 'start' : startElement.id;
        
        if (markdown.trim() !== "" && !settings.exclude.includes(sectionID)) {
            // Add subsection pages
            mdStore.push({section: headersPageName, content: turndownService.turndown(subsectionLinks) + " "})
            // Edit start to include frontmatter & subsection links
            markdown = "---\ntitle: The PLV Media Manual\n---\n\n## [→ Click to View Subsections ←](" + headersPageName + ")\n\n" + markdown;
            // Add section
            mdStore.push({section: sectionID, content: markdown})
        };

        startElement = currentSection.nextStartingNode;

        if (!currentSection.nextStartingNode){
            done=true;
        };
    };

    // Build Index Page
    var indexPage = buildIndexPage(doc, settings.index, linkLUT, settings.exclude);
    mdStore.push({section: "index", content: indexPage});
    
    console.log("Made these markdown files:", mdStore);

    writeOutToZip(mdStore, imgs);
}

var createSubsectionLinks = function (section, linkLUT) {
    var doc = document.implementation.createHTMLDocument("");
    var list = doc.createElement('ul');
    for (let i = 0; i < section.children.length; i++) {
        const e = section.children[i];
        if (e.tagName && e.tagName.toLowerCase().match(/h[0-9]/)) {
            var level = parseInt(e.tagName[e.tagName.length - 1]) - 1;
            const listItem = doc.createElement('li');
            const a = document.createElement('a');
            var title = e.querySelector('span').innerText;
            if (title.trim() !== '') {
                a.setAttribute('href', linkLUT[e.id]);
                a.innerText = title;
                listItem.appendChild(a)
                if (level == 0) {
                    list.append(listItem)
                }
                else {
                    const ulItem = doc.createElement('ul');
                    ulItem.append(listItem);
                    appendToLevel(list, ulItem, level);
                }
            }
        }
    }
    doc.body.append(list);
    return doc;
}

var appendToLevel = function (head, obj, level) {
    // Find level, append object.
    var numIterations = 2 * (level - 1) + 1;
    var currentElement = head;
    for (let i = 0; i < numIterations; i++) {
        if (currentElement.children.length > 0) {
            currentElement = currentElement.children[currentElement.children.length - 1];
        }
    }
    if (currentElement) {
        currentElement.append(obj);
    }
}

var appendAllChildren = function (to, from) {
    for (let i = 0; i < from.length; i++) {
        const child = from[i];
        to.append(child);
    };
};

var getListIds = function(lists) {
    var ids = [];
    for (let i = 0; i < lists.length; i++) {
        const l = lists[i];
        if (!ids.includes(l.id)) {
            ids.push(l.id)
        }
    }
    return ids;
}

var getAllLists = function(doc) {
    var lists = []; // [] of HTMLCollection

    // All lists should be ul's by now.
    var allUl = doc.getElementsByTagName('ul');
    for (let i = 0; i < allUl.length; i++) {
        const ul = allUl[i];
        var id = ul.classList.value.match(/\blst-kix_\w+/)[0]; // matches lst-kix_[IDSTUFF] but NOT the last little bit with -[number], bc that changes
        if (id) {
            // get the -[number] level (nested level)
            var level = ul.classList.value.match(/\blst-kix_[\w-]+/)[0].split('-')[2];
            var doesContainStart = ul.classList.value.includes('start');
            lists.push({element: ul, id: id, level: level, isStart: doesContainStart, order: i}); // order might not be needed...
        }
    }

    return lists;
}

var buildIndexPage = function (doc, index, linkLUT, exclude) {
    // Format: 
    // Intro (hey welcome to media :D)
    // [index page] as linked on actual doc
    // Custom TOC
    var indexDocument = document.implementation.createHTMLDocument("");
    var turndownService = new TurndownService()

    // Intro (TODO: Make decent)
    const topTitle = document.createElement("h1");
    topTitle.innerText = "The PLV Media Manual";
    const topSubtitle = document.createElement("h2");
    topSubtitle.innerText = "Ethan Harvey, et al.";
    const para = document.createElement("p");
    para.innerText = "Welcome to the PLV Media Manual, a guide to all things Media Academy! Click one of the links below to be taken to a section."
    const time = document.createElement("p");
    const italics = document.createElement("i");
    italics.innerText = "Site Last Updated: " + Date().toLocaleString();
    time.appendChild(italics);
    indexDocument.body.appendChild(topTitle);
    indexDocument.body.appendChild(topSubtitle);
    indexDocument.body.appendChild(para);
    indexDocument.body.appendChild(time);

    // [Index Page] - if exists.
    var section = null;
    if (index) { section = findUntilNext(doc, doc.getElementById(index)).section.body; } 
    if (section) { indexDocument.body.append(section); };

    // Make and append TOC
    const TOCTitle = document.createElement("h2");
    TOCTitle.innerText = "Table of Contents";
    indexDocument.body.append(TOCTitle);

    const tocList = document.createElement("ul");

    const h1s = doc.getElementsByTagName("h1");
    for (let i = 0; i < h1s.length; i++) {
        const e = h1s[i];
        var link = e.id;
        if (link && !exclude.includes(link)){
            // Create with valid link
            var title = e.querySelector('span').innerText;
            if (title.trim() !== ''){
                const li = document.createElement("li");
                const a = document.createElement("a");
                a.setAttribute('href', linkLUT[link]);
                a.innerText = title;
                li.appendChild(a);
                tocList.appendChild(li);
            }
        }
    };

    indexDocument.body.appendChild(tocList);
    var markdown = turndownService.turndown(indexDocument);

    return markdown;
};

var findUntilNext = function(doc, startNode, headerLevel = 'h1'){
    var allElements = doc.body.children;
    
    var index = null;
    if (startNode) {
        index = Array.from(allElements).indexOf(startNode);
        
        if (index == null || index == -1) {
            // Something has gone wrong.
            console.error('Something went wrong. Check findUntilNext()');
            return null;
        }
    }
    else {
        index = -1;
    }

    // Iterate through document structure, adding to new/fake document along the way.
    var currentMiniDoc = document.implementation.createHTMLDocument("");
    if (startNode) { currentMiniDoc.body.appendChild(startNode.cloneNode(true)); } // Include first tag
    for (let i = index + 1 /* +1 so that we don't end on self */; i < allElements.length; i++) {
        const e = allElements[i];

        // Iterate until you find tag
        if (e.tagName.toLowerCase() == headerLevel.toLowerCase()){
            return {section: currentMiniDoc, nextStartingNode: allElements[i]};
        }

        currentMiniDoc.body.appendChild(e.cloneNode(true));
    }
    // Process finished
    return {section: currentMiniDoc, nextStartingNode: null};
}

var findHeaderWithText = function(headers, text){
    for (let i = 0; i < headers.length; i++) {
        const e = headers[i];
        if (e.innerHTML.includes(text)){
            return e;
        }
    }
    return null;
}

var getSettings = function(doc) {
    var settings = {};
    settings.exclude = [];
    settings.index = '';
    // Get all h1's
    const h1s = doc.getElementsByTagName("h1");

    // Find header
    const settingsHeader = findHeaderWithText(h1s, '[Formatting]');

    // If found, process
    if (settingsHeader) {
        var section = findUntilNext(doc, settingsHeader).section;
        var subHeaders = section.getElementsByTagName('h2');

        // Get Excluded Sections
        var excludeSection = findUntilNext(section, findHeaderWithText(subHeaders, '[Exclude]'), 'h2').section.body;
        excludeSection.firstChild.remove(); // remove header
        for (let i = 0; i < excludeSection.children.length; i++) {
            const e = excludeSection.children[i];
            // Get setion id's
            settings.exclude.push($(e).find('a').attr('href').replace('#', ''));
        }

        var indexSection = findUntilNext(section, findHeaderWithText(subHeaders, '[Index]'), 'h2').section.body;
        indexSection.firstChild.remove();
        settings.index = $(indexSection.firstChild).find('a').attr('href').replace('#', '');

        console.log('Settings:', settings);
        return settings;
    } 
    else {
        return settings;
    }
}

var writeOutToZip = async function(markdown, imgs = null){
    updateMessage("Finished building document, writing out to zip...");
    const blobWriter = new zip.BlobWriter("application/zip");
    const writer = new zip.ZipWriter(blobWriter);
    
    // Add markdown files
    for (let i = 0; i < markdown.length; i++) {
        const e = markdown[i];
        
        // use a TextReader to read the String to add
        await writer.add(e.section + ".md", new zip.TextReader(e.content));
    }

    // Add CNAME and _config.yml
    await writer.add("CNAME", new zip.TextReader("guide.plv.media"));
    await writer.add("_config.yml", new zip.TextReader('theme: jekyll-theme-tactile\ntitle: The PLV Media Manual\ndescription: <a href="https://plvmedia.github.io/guide/">Table Of Contents</a>'));

    // Add scss
    await writer.add("/assets/css/style.scss", new zip.TextReader('---\n---\n\n@import "{{ site.theme }}";\n\nh3 {\n  color: #303030!important\n}'));
    
    // Add images
    // Probably a TERRIBLY inefficent way of doing this... oh well, it's good enough for government work.
    if (imgs){
        for (let i = 0; i < imgs.length; i++) {
            const e = imgs[i];
            await writer.add(e.filename, new zip.BlobReader(e.content));
        };
    };

    // close the ZipReader
    await writer.close();

    // get the zip file as a Blob
    const blob = blobWriter.getData();

    finalBlob = blobWriter.getData();
    
    saveAs(blob, "PLVMedia-Manual-markdown-out.zip");

    updateMessage('Finished! Downloading zip file...');
    const div = document.querySelector("#layout > div.content.pure-u-1.pure-u-md-3-4.bg-primary > div");
    const button = document.createElement("a");
    button.classList.add('pure-button');
    button.classList.add('bg-blue');
    button.id = 'blobDownloader';
    button.innerText = 'Download Zip Again (if you cancelled the download on accident)'
    div.appendChild(button);
    button.addEventListener("click", function (){
        saveAs(finalBlob, "PLVMedia-Manual-markdown-out.zip");
    });
}

var updateMessage = function(msg){
    $('#output')[0].innerHTML += '<br>' + msg;
};
