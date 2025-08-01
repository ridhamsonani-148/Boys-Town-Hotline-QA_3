import React, { useState, useEffect } from 'react';
import './PerformanceRubrics.css';
import HeadsetIcon from "../../assets/headset_mic.png";
// SVG Components
const WestIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M7.5 2L3.5 6L7.5 10" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);



const ArrowDownIcon = ({ className }) => (
  <svg width="12" height="8" viewBox="0 0 12 8" fill="none" className={className}>
    <path d="M1 1L6 6L11 1" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Skill point definitions
const skillPoints = {
  "Rapport Skills": {
    "Tone": 1,
    "Professional": 1,
    "Conversational Style": 1,
    "Supportive Initial Statement": 1,
    "Affirmation and Praise": 1,
    "Reflection of Feelings": 2,
    "Explores Problem(s)": 1,
    "Values the Person": 1,
    "Non-Judgmental": 1
  },
  "Counseling Skills": {
    "Clarifies Non-Suicidal Safety": 1,
    "Suicide Safety Assessment-SSA Initiation and Completion": 4,
    "Exploration of Buffers": 1,
    "Restates then Collaborates Options": 1,
    "Identifies a Concrete Plan": 2,
    "Appropriate Termination": 1
  },
  "Organizational Skills": {
    "POP Model - does not rush": 1,
    "POP Model - does not dwell": 1
  },
  "Technical Skills": {
    "Greeting": 1
  }
};

// Calculate total possible points (multiplied by 4)
const calculateTotalPossiblePoints = () => {
  let total = 0;
  Object.keys(skillPoints).forEach(category => {
    Object.keys(skillPoints[category]).forEach(skill => {
      total += skillPoints[category][skill];
    });
  });
  return total * 4;
};

const TOTAL_POSSIBLE_POINTS = calculateTotalPossiblePoints();

function PerformanceRubrics({ fileName, s3Url, onBack }) {
  const [rubricData, setRubricData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState({});

  const toggleSection = (sectionName) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionName]: !prev[sectionName]
    }));
  };

  useEffect(() => {
    const fetchRubricData = async () => {
      try {
        //console.log('Fetching rubric data for:', fileName);
        
        if (!fileName) {
          throw new Error('Invalid file name provided');
        }
        
        // Import the uploadService
        const { uploadService } = await import('../../services/uploadService');
        
        // Use the getResults method with the original filename
        const data = await uploadService.getResults(fileName);
        //console.log('Fetched data:', data);
        
        setRubricData(data);
      } catch (error) {
        console.error('Error fetching rubric data:', error);
        // Fallback to S3 URL if available
        if (s3Url && s3Url !== 'mock-url') {
          try {
            const response = await fetch(s3Url);
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            setRubricData(data);
          } catch (fallbackError) {
            console.error('Error setting fallback data:', fallbackError);
          }
        }
      } finally {
        setLoading(false);
      }
    };

    fetchRubricData();
  }, [fileName, s3Url]);

  if (loading || !rubricData) {
    return <div className="performance-rubrics-loading">Loading...</div>;
  }

  return (
    <div className="performance-rubrics-container">
      <div className="performance-rubrics-header">
        <div className="back-button" onClick={onBack}>
          <div className="back-icon-container">
            <WestIcon className="west-icon" />
          </div>
        </div>
      </div>

      <div className="file-info-card">
        <div className="file-icon-container">
          <img src={HeadsetIcon} alt="Headset" className="headset-icon" />
        </div>
        <div className="file-name">{fileName}</div>
        <div className="overall-score">{Math.round(rubricData.percentageScore)}%</div>
        <div className="status-badge">
          <span className="status-text">{rubricData.criteria}</span>
        </div>
      </div>

      <div className="rubrics-card">
        <h2 className="rubrics-title">Detailed Performance Rubrics</h2>
        
        <div className="rubrics-list">
          {Object.entries(rubricData.categories).map(([categoryName, categoryData]) => {
            // Calculate max possible points for this category
            let maxCategoryPoints = 0;
            const categoryKey = categoryName.replace(/\s+/g, ' ').replace(/-/g, '–');
            const skillCategory = Object.keys(skillPoints).find(k => k.toUpperCase() === categoryKey.toUpperCase());
            
            if (skillCategory && skillPoints[skillCategory]) {
              Object.values(skillPoints[skillCategory]).forEach(points => {
                maxCategoryPoints += points * 4;
              });
            } else {
              // Fallback if category not found
              maxCategoryPoints = Object.keys(categoryData.criteria).length * 4;
            }
            
            const percentage = Math.min(100, (categoryData.multipliedScore / maxCategoryPoints) * 100);
            return (
              <div key={categoryName} className="rubric-item">
                <div className="rubric-header" onClick={() => toggleSection(categoryName)}>
                  <div className="rubric-left">
                    <ArrowDownIcon className={`expand-arrow ${expandedSections[categoryName] ? 'expanded' : ''}`} />
                    <h3 className="rubric-name">{categoryName}</h3>
                  </div>
                  <div className="rubric-score">{categoryData.multipliedScore} / {maxCategoryPoints}</div>
                </div>
                <div className="rubric-status">
                  <span className="status-text">Meets Criteria</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-background"></div>
                  <div className="progress-fill" style={{ width: `${percentage}%` }}></div>
                </div>
                
                {expandedSections[categoryName] && (
                  <div className="criteria-details">
                    {Object.entries(categoryData.criteria).map(([criteriaName, criteriaData]) => (
                      <div key={criteriaName} className="criteria-item">
                        <div className="criteria-header">
                          <span className="criteria-name">{criteriaName}</span>
                          <span className="criteria-score">{criteriaData.score * 4}/{skillPoints[skillCategory]?.[criteriaName] * 4}</span>
                        </div>
                        <div className="criteria-progress-bar">
                          <div className="criteria-progress-background"></div>
                          <div 
                            className="criteria-progress-fill" 
                            style={{ 
                              width: `${Math.min(100, (criteriaData.score * 4 / (skillPoints[skillCategory]?.[criteriaName] * 4)) * 100)}%` 
                            }}
                          ></div>
                        </div>
                        <div className="criteria-observation">{criteriaData.observation}</div>
                        <div className="criteria-evidence">{criteriaData.evidence}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default PerformanceRubrics;