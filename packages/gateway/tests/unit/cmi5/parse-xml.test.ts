import { describe, it, expect } from "vitest";
import { parseCmi5Xml } from "../../../src/cmi5/parse-xml.js";

describe("parseCmi5Xml", () => {
  it("parses a simple course with 2 AUs and no blocks", () => {
    const xml = `
      <courseStructure>
        <course id="course-1">
          <title><langstring lang="en-US">My Course</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed" masteryScore="0.8">
          <title><langstring lang="en-US">AU One</langstring></title>
          <url>http://example.com/au1</url>
        </au>
        <au id="au-2" moveOn="Completed">
          <title><langstring lang="en-US">AU Two</langstring></title>
          <url>http://example.com/au2</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.id).toBe("course-1");
    expect(cs.title).toBe("My Course");
    expect(Object.keys(cs.aus)).toEqual(["au-1", "au-2"]);
    expect(cs.aus["au-1"]).toEqual({
      id: "au-1", title: "AU One", moveOn: "Passed",
      masteryScore: 0.8, launchUrl: "http://example.com/au1", launchMethod: "OwnWindow",
    });
    expect(cs.aus["au-2"]).toEqual({
      id: "au-2", title: "AU Two", moveOn: "Completed",
      launchUrl: "http://example.com/au2", launchMethod: "OwnWindow",
    });
    expect(Object.keys(cs.blocks)).toEqual([]);
    expect(cs.rootChildren).toEqual([
      { type: "au", id: "au-1" },
      { type: "au", id: "au-2" },
    ]);
  });

  it("parses a course with nested blocks", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">Course</langstring></title>
        </course>
        <block id="block-1">
          <title><langstring lang="en-US">Block One</langstring></title>
          <au id="au-1" moveOn="Passed">
            <title><langstring lang="en-US">AU 1</langstring></title>
            <url>http://example.com/au1</url>
          </au>
          <block id="block-2">
            <title><langstring lang="en-US">Nested Block</langstring></title>
            <au id="au-2" moveOn="Completed">
              <title><langstring lang="en-US">AU 2</langstring></title>
              <url>http://example.com/au2</url>
            </au>
          </block>
        </block>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.rootChildren).toEqual([{ type: "block", id: "block-1" }]);
    expect(cs.blocks["block-1"].children).toEqual([
      { type: "au", id: "au-1" },
      { type: "block", id: "block-2" },
    ]);
    expect(cs.blocks["block-2"].children).toEqual([
      { type: "au", id: "au-2" },
    ]);
  });

  it("defaults moveOn to NotApplicable", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.aus["au-1"].moveOn).toBe("NotApplicable");
  });

  it("defaults launchMethod to OwnWindow", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.aus["au-1"].launchMethod).toBe("OwnWindow");
  });

  it("parses AnyWindow launchMethod", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed" launchMethod="AnyWindow">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.aus["au-1"].launchMethod).toBe("AnyWindow");
  });

  it("preserves interleaved AU/block order in rootChildren", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed">
          <title><langstring lang="en-US">A1</langstring></title>
          <url>http://example.com/1</url>
        </au>
        <block id="b1">
          <title><langstring lang="en-US">B1</langstring></title>
          <au id="au-2" moveOn="Completed">
            <title><langstring lang="en-US">A2</langstring></title>
            <url>http://example.com/2</url>
          </au>
        </block>
        <au id="au-3" moveOn="NotApplicable">
          <title><langstring lang="en-US">A3</langstring></title>
          <url>http://example.com/3</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.rootChildren).toEqual([
      { type: "au", id: "au-1" },
      { type: "block", id: "b1" },
      { type: "au", id: "au-3" },
    ]);
  });

  it("throws on missing <courseStructure>", () => {
    expect(() => parseCmi5Xml("<foo/>")).toThrow("Missing <courseStructure>");
  });

  it("throws on missing <course>", () => {
    expect(() => parseCmi5Xml("<courseStructure></courseStructure>"))
      .toThrow("Missing <course>");
  });

  it("throws on missing AU id", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au moveOn="Passed">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;
    expect(() => parseCmi5Xml(xml)).toThrow('missing required attribute "id"');
  });

  it("parses purpose=assessment on AU", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed" purpose="assessment">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.aus["au-1"].purpose).toBe("assessment");
  });

  it("omits purpose when not assessment", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed">
          <title><langstring lang="en-US">A</langstring></title>
          <url>http://example.com</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.aus["au-1"].purpose).toBeUndefined();
  });

  it("throws on missing AU url", () => {
    const xml = `
      <courseStructure>
        <course id="c1">
          <title><langstring lang="en-US">C</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed">
          <title><langstring lang="en-US">A</langstring></title>
        </au>
      </courseStructure>`;
    expect(() => parseCmi5Xml(xml)).toThrow('missing <url>');
  });

  it("parses XML with xmlns namespace", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
        <course id="c1">
          <title><langstring lang="en-US">Namespaced Course</langstring></title>
        </course>
        <au id="au-1" moveOn="Passed" masteryScore="0.8">
          <title><langstring lang="en-US">AU One</langstring></title>
          <url>http://example.com/au1</url>
        </au>
      </courseStructure>`;

    const cs = parseCmi5Xml(xml);
    expect(cs.id).toBe("c1");
    expect(cs.title).toBe("Namespaced Course");
    expect(cs.aus["au-1"]).toEqual({
      id: "au-1", title: "AU One", moveOn: "Passed",
      masteryScore: 0.8, launchUrl: "http://example.com/au1", launchMethod: "OwnWindow",
    });
    expect(cs.rootChildren).toEqual([{ type: "au", id: "au-1" }]);
  });
});
